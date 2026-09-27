// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

function isExitStatus(error) {
  return (
    error && (error.name === "ExitStatus" || Number.isInteger(error.status))
  );
}

const BASE_ARGUMENTS = ["--nostartup", "--nousermodules", "--noipc", "--quiet"];

function argumentsFor(options) {
  const args = [...BASE_ARGUMENTS];
  if (options.code !== undefined) {
    args.push("--execute", String(options.code));
  } else if (options.file !== undefined) {
    args.push("--file", String(options.file));
  }
  if (Array.isArray(options.args)) args.push(...options.args.map(String));
  return args;
}

/**
 * Run one isolated Nelson command in a fresh WebAssembly instance.
 *
 * A fresh instance keeps the initial integration deterministic while the
 * native engine still owns process-wide state. WebAssembly teardown is left
 * to the JavaScript realm, which owns the instance and its linear memory; the
 * native process-exit destructors are therefore not run. The factory is the
 * default export of the generated nelson-portable.mjs file.
 */
export async function runNelson(factory, options = {}) {
  const stdout = [];
  const stderr = [];
  const args = argumentsFor(options);

  const emit = (destination, callback, value) => {
    destination.push(value);
    if (callback) {
      callback(value);
    }
  };

  let exitCode = 0;
  let instance;
  try {
    instance = await factory({
      ...(options.moduleOptions || {}),
      arguments: args,
      noExitRuntime: true,
      ...(options.locateFile ? { locateFile: options.locateFile } : {}),
      print: (value) => emit(stdout, options.print, value),
      printErr: (value) => emit(stderr, options.printErr, value),
    });
  } catch (error) {
    if (!isExitStatus(error)) {
      throw error;
    }
    exitCode = Number.isInteger(error.status) ? error.status : 0;
  }
  if (instance && options.afterRun) await options.afterRun(instance);

  return {
    exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

export function createNelsonRunner(factory, defaultOptions = {}) {
  return {
    evaluate: (code, options = {}) =>
      runNelson(factory, { ...defaultOptions, ...options, code }),
    runFile: (file, options = {}) =>
      runNelson(factory, { ...defaultOptions, ...options, file }),
  };
}

/**
 * Keep one Emscripten module and Nelson evaluator alive for a Worker session.
 * Calls are serialized because the evaluator is intentionally single-threaded.
 */
export function createPersistentNelsonRunner(factory, defaultOptions = {}) {
  let instancePromise;
  let activeOutput = null;
  let queue = Promise.resolve();

  const emit = (destination, defaultCallback, value) => {
    if (activeOutput) {
      activeOutput[destination].push(value);
      const callback =
        destination === "stdout" ? activeOutput.print : activeOutput.printErr;
      (callback || defaultCallback)?.(value);
    } else {
      defaultCallback?.(value);
    }
  };

  const emitEngineOutput = (error, value) => {
    const callback = activeOutput
      ? error
        ? activeOutput.printErr
        : activeOutput.print
      : error
        ? defaultOptions.printErr
        : defaultOptions.print;
    callback?.(String(value));
  };

  const initialize = () => {
    if (!instancePromise) {
      const moduleOptions = defaultOptions.moduleOptions || {};
      const configuredOutput = moduleOptions.onNelsonOutput;
      instancePromise = factory({
        ...moduleOptions,
        // Instantiate only. Running main here makes modularized Emscripten
        // reject its factory promise before the reusable instance is returned.
        noInitialRun: true,
        noExitRuntime: true,
        ...(defaultOptions.locateFile
          ? { locateFile: defaultOptions.locateFile }
          : {}),
        print: (value) => emit("stdout", defaultOptions.print, value),
        printErr: (value) => emit("stderr", defaultOptions.printErr, value),
        onNelsonOutput: (error, value) => {
          configuredOutput?.(error, value);
          emitEngineOutput(Boolean(error), value);
        },
      }).then((instance) => {
        const hasEngineApi =
          typeof instance.ccall === "function" &&
          typeof instance._nlsPortableEvaluate === "function";
        if (!hasEngineApi && typeof instance.callMain !== "function") {
          throw new TypeError(
            "The Nelson WebAssembly module exports neither the engine API nor callMain",
          );
        }
        if (
          hasEngineApi &&
          instance.ccall("nlsPortableStart", "number", [], []) !== 0
        ) {
          throw new Error("The Nelson portable engine could not start");
        }
        return instance;
      });
    }
    return instancePromise;
  };

  const enqueue = (work) => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };

  const run = (options) =>
    enqueue(async () => {
      const instance = await initialize();
      const stdout = [];
      const stderr = [];
      let errorIdentifier = "";
      let errorMessage = "";
      activeOutput = {
        stdout,
        stderr,
        print: options.print,
        printErr: options.printErr,
      };
      let exitCode = 0;
      try {
        if (options.beforeRun) await options.beforeRun(instance);
        const hasEngineApi =
          options.code !== undefined &&
          typeof instance.ccall === "function" &&
          typeof instance._nlsPortableEvaluate === "function";
        if (hasEngineApi) {
          exitCode = instance.ccall(
            "nlsPortableEvaluate",
            "number",
            ["string"],
            [String(options.code)],
          );
          const capturedOutput = instance.ccall(
            "nlsPortableStdout",
            "string",
            [],
            [],
          );
          const capturedError = instance.ccall(
            "nlsPortableStderr",
            "string",
            [],
            [],
          );
          if (capturedOutput) stdout.push(capturedOutput);
          if (capturedError) stderr.push(capturedError);
          if (typeof instance._nlsPortableErrorIdentifier === "function") {
            errorIdentifier =
              instance.ccall("nlsPortableErrorIdentifier", "string", [], []) ||
              "";
          }
          if (typeof instance._nlsPortableErrorMessage === "function") {
            errorMessage =
              instance.ccall("nlsPortableErrorMessage", "string", [], []) || "";
          }
        } else {
          const status = instance.callMain(argumentsFor(options));
          if (Number.isInteger(status)) exitCode = status;
        }
      } catch (error) {
        if (!isExitStatus(error)) throw error;
        exitCode = Number.isInteger(error.status) ? error.status : 0;
      } finally {
        activeOutput = null;
      }
      if (options.afterRun) await options.afterRun(instance);
      return {
        exitCode,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
        ...(errorIdentifier ? { errorIdentifier, errorMessage } : {}),
      };
    });

  return {
    initialize,
    renderFigurePng: (handle) =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall !== "function" ||
          typeof instance._nlsPortableFigurePngBase64 !== "function"
        ) {
          throw new Error("Portable figure PNG export is unavailable");
        }
        const encoded = instance.ccall(
          "nlsPortableFigurePngBase64",
          "string",
          ["bigint"],
          [BigInt(handle)],
        );
        if (!encoded) throw new Error(`Figure ${Number(handle)} is unavailable`);
        return encoded;
      }),
    saveFigure: (handle, path, options = {}) =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall !== "function" ||
          typeof instance._nlsPortableSaveFigure !== "function"
        ) {
          throw new Error("Portable figure file export is unavailable");
        }
        if (options.beforeRun) await options.beforeRun(instance);
        let status;
        try {
          status = instance.ccall(
            "nlsPortableSaveFigure",
            "number",
            ["bigint", "string"],
            [BigInt(handle), String(path)],
          );
        } finally {
          if (options.afterRun) await options.afterRun(instance);
        }
        if (status !== 0) {
          throw new Error(`Figure ${Number(handle)} could not be saved to '${path}'`);
        }
        return { ok: true, path: String(path) };
      }),
    analyzeCode: (path, source) =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall !== "function" ||
          typeof instance._nlsPortableAnalyzeCode !== "function"
        ) {
          return [];
        }
        const encoded = instance.ccall(
          "nlsPortableAnalyzeCode",
          "string",
          ["string", "string"],
          [String(path), String(source)],
        );
        const diagnostics = JSON.parse(encoded || "[]");
        if (!Array.isArray(diagnostics)) {
          throw new TypeError("Invalid Nelson code analyzer result");
        }
        return diagnostics;
      }),
    loadUserModules: (options = {}) =>
      enqueue(async () => {
        const instance = await initialize();
        if (options.beforeRun) await options.beforeRun(instance);
        let exitCode = 0;
        if (typeof instance._nlsPortableLoadUserModules === "function") {
          exitCode = instance.ccall(
            "nlsPortableLoadUserModules",
            "number",
            [],
            [],
          );
        }
        if (options.afterRun) await options.afterRun(instance);
        return { exitCode };
      }),
    evaluate: (code, options = {}) =>
      run({ ...defaultOptions, ...options, code }),
    runFile: (file, options = {}) =>
      run({ ...defaultOptions, ...options, file }),
    reset: () =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall === "function" &&
          typeof instance._nlsPortableReset === "function"
        ) {
          instance.ccall("nlsPortableReset", null, [], []);
        } else {
          instancePromise = undefined;
        }
      }),
  };
}
