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

function ensureRuntimeDirectory(instance, path) {
  if (!instance?.FS) return;
  const exists = instance.FS.analyzePath?.(path)?.exists;
  if (!exists) instance.FS.mkdirTree(path);
}

function ensureRuntimeDirectories(instance) {
  ensureRuntimeDirectory(instance, "/tmp");
  ensureRuntimeDirectory(instance, "/temp");
}

async function portableCcall(
  instance,
  name,
  returnType,
  argumentTypes = [],
  args = [],
  options = {},
) {
  const result = instance.ccall(
    name,
    returnType,
    argumentTypes,
    args,
    options.async ? { async: true } : undefined,
  );
  return await result;
}

function normalizedSet(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return new Set(values.map((value) => String(value)).filter(Boolean));
}

function selectedRuntimeResourceSelection(manifest, runtimeIndex, options = {}) {
  const modules = normalizedSet(options.modules);
  const kinds = normalizedSet(options.kinds);
  const bundles = [];
  const indexModules = Array.isArray(runtimeIndex?.modules)
    ? runtimeIndex.modules
    : [];
  const hasBundleIndex = indexModules.some(
    (entry) => entry && typeof entry === "object" && entry.bundles,
  );
  for (const entry of indexModules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const module = String(entry.module ?? "");
    if (!module || (modules && !modules.has(module))) continue;
    const moduleBundles = entry.bundles;
    if (!moduleBundles || typeof moduleBundles !== "object") continue;
    for (const kind of ["tests", "help"]) {
      if (kinds && !kinds.has(kind)) continue;
      const file = String(moduleBundles[kind]?.file ?? "");
      if (file && !file.split("/").includes("..")) bundles.push(file);
    }
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const selectedFiles = files
    .map((entry) =>
      entry && typeof entry === "object" ? String(entry.file ?? "") : "",
    )
    .filter((file) => {
      const runtimeMatch =
        /^runtime-resources\/modules\/([^/]+)\/(tests|help)\//.exec(file);
      const examplesMatch = /^examples\/files\/([^/]+)\/(examples)\//.exec(
        file,
      );
      const match = runtimeMatch || examplesMatch;
      if (!match || file.split("/").includes("..")) return false;
      if (runtimeMatch && hasBundleIndex) return false;
      if (modules && !modules.has(match[1])) return false;
      if (kinds && !kinds.has(match[2])) return false;
      return true;
    });
  return { bundles, files: selectedFiles };
}

function runtimeResourceVirtualPath(packagedFile) {
  if (packagedFile.split("/").includes("..")) return null;
  const runtimePrefix = "runtime-resources/modules/";
  if (packagedFile.startsWith(runtimePrefix)) {
    return `/modules/${packagedFile.slice(runtimePrefix.length)}`;
  }
  const examplesMatch = /^examples\/files\/([^/]+)\/examples\/(.+)$/.exec(
    packagedFile,
  );
  if (!examplesMatch) return null;
  if (examplesMatch[2].split("/").includes("..")) {
    return null;
  }
  return `/modules/${examplesMatch[1]}/examples/${examplesMatch[2]}`;
}

function ensureRuntimeFileDirectory(instance, path) {
  const directory = path.split("/").slice(0, -1).join("/") || "/";
  ensureRuntimeDirectory(instance, directory);
}

function unpackRuntimeResourceBundle(bytes) {
  if (bytes.subarray(0, 8).toString("ascii") !== "NLRPACK1") {
    throw new Error("Runtime resource bundle has an unsupported format");
  }
  const headerLength = bytes.readUInt32LE(8);
  const payloadOffset = 12 + headerLength;
  const header = JSON.parse(bytes.subarray(12, payloadOffset).toString("utf8"));
  if (header.formatVersion !== 1 || !Array.isArray(header.files)) {
    throw new Error("Runtime resource bundle manifest is invalid");
  }
  return header.files.map((entry) => {
    const file = String(entry.file ?? "");
    const offset = Number(entry.offset);
    const length = Number(entry.bytes);
    if (
      !file ||
      file.split("/").includes("..") ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      payloadOffset + offset + length > bytes.byteLength
    ) {
      throw new Error("Runtime resource bundle entry is invalid");
    }
    return {
      file,
      bytes: bytes.subarray(payloadOffset + offset, payloadOffset + offset + length),
    };
  });
}

function writePackagedRuntimeResource(instance, packagedFile, bytes) {
  const virtualPath = runtimeResourceVirtualPath(packagedFile);
  if (!virtualPath) return false;
  ensureRuntimeFileDirectory(instance, virtualPath);
  instance.FS.writeFile(virtualPath, bytes);
  return true;
}

export async function mountPackagedRuntimeResources(
  instance,
  browserRoot,
  options = {},
) {
  if (!instance?.FS || !browserRoot) return 0;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const manifest = JSON.parse(
    await readFile(join(browserRoot, "manifest.json"), "utf8"),
  );
  const groups = manifest?.delivery?.onDemand;
  const hasRuntimeResources =
    Array.isArray(groups) &&
    groups.some((group) => {
      if (!group || typeof group !== "object") return false;
      return group.id === "runtime-resources" || group.trigger === "runtime-resources";
    });
  if (!hasRuntimeResources) return 0;
  const runtimeIndex = JSON.parse(
    await readFile(join(browserRoot, "runtime-resources", "index.json"), "utf8"),
  );
  const selection = selectedRuntimeResourceSelection(manifest, runtimeIndex, options);
  let mounted = 0;
  for (const bundle of selection.bundles) {
    const bytes = await readFile(join(browserRoot, ...bundle.split("/")));
    for (const resource of unpackRuntimeResourceBundle(bytes)) {
      if (writePackagedRuntimeResource(instance, resource.file, resource.bytes)) mounted += 1;
    }
  }
  for (const file of selection.files) {
    const bytes = await readFile(join(browserRoot, ...file.split("/")));
    if (writePackagedRuntimeResource(instance, file, bytes)) mounted += 1;
  }
  return mounted;
}

export function browserDirectoryForRuntimeModule(modulePath) {
  return String(modulePath).replace(/[/\\][^/\\]+$/, "/browser");
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
  const deferMain = Boolean(options.beforeRun);
  try {
    instance = await factory({
      ...(options.moduleOptions || {}),
      arguments: args,
      ...(deferMain ? { noInitialRun: true } : {}),
      noExitRuntime: true,
      ...(options.locateFile ? { locateFile: options.locateFile } : {}),
      print: (value) => emit(stdout, options.print, value),
      printErr: (value) => emit(stderr, options.printErr, value),
    });
    if (deferMain) {
      ensureRuntimeDirectories(instance);
      await options.beforeRun(instance);
      const status = await instance.callMain(args);
      if (Number.isInteger(status)) exitCode = status;
    }
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
      const configuredClearTerminal = moduleOptions.onNelsonClearTerminal;
      const configuredHtml = moduleOptions.onNelsonHtml;
      const configuredExpandableText = moduleOptions.onNelsonExpandableText;
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
        onNelsonClearTerminal: () => {
          configuredClearTerminal?.();
          activeOutput?.clear?.();
        },
        onNelsonHtml: (html) => {
          configuredHtml?.(html);
          activeOutput?.html?.(String(html));
        },
        onNelsonExpandableText: (id, text) => {
          configuredExpandableText?.(id, text);
          activeOutput?.expandable?.(Number(id), String(text));
        },
      }).then(async (instance) => {
        ensureRuntimeDirectories(instance);
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
          (await portableCcall(instance, "nlsPortableStart", "number", [], [], {
            async: true,
          })) !== 0
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
        clear: options.clear,
        html: options.html,
        expandable: options.expandable,
      };
      let exitCode = 0;
      try {
        if (options.beforeRun) await options.beforeRun(instance);
        const hasEngineApi =
          options.code !== undefined &&
          typeof instance.ccall === "function" &&
          typeof instance._nlsPortableEvaluate === "function";
        if (hasEngineApi) {
          exitCode = await portableCcall(
            instance,
            "nlsPortableEvaluate",
            "number",
            ["string"],
            [String(options.code)],
            { async: true },
          );
          const capturedOutput = await portableCcall(
            instance,
            "nlsPortableStdout",
            "string",
            [],
            [],
          );
          const capturedError = await portableCcall(
            instance,
            "nlsPortableStderr",
            "string",
            [],
            [],
          );
          if (capturedOutput) stdout.push(capturedOutput);
          if (capturedError) stderr.push(capturedError);
          if (typeof instance._nlsPortableErrorIdentifier === "function") {
            errorIdentifier =
              (await portableCcall(
                instance,
                "nlsPortableErrorIdentifier",
                "string",
                [],
                [],
              )) ||
              "";
          }
          if (typeof instance._nlsPortableErrorMessage === "function") {
            errorMessage =
              (await portableCcall(
                instance,
                "nlsPortableErrorMessage",
                "string",
                [],
                [],
              )) || "";
          }
        } else {
          const status = await instance.callMain(argumentsFor(options));
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
        const encoded = await portableCcall(
          instance,
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
          status = await portableCcall(
            instance,
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
        const encoded = await portableCcall(
          instance,
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
    debuggerState: () =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall !== "function" ||
          typeof instance._nlsPortableDebuggerState !== "function"
        ) {
          return { running: false, currentLine: null, currentFile: null, stack: [] };
        }
        return JSON.parse(
          (await portableCcall(
            instance,
            "nlsPortableDebuggerState",
            "string",
            [],
            [],
          )) ||
            '{"running":false,"currentLine":null,"currentFile":null,"stack":[]}',
        );
      }),
    debuggerGetBreakpoints: (file) =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall !== "function" ||
          typeof instance._nlsPortableDebuggerGetBreakpoints !== "function"
        ) {
          return { file: String(file), lines: [] };
        }
        return JSON.parse(
          (await portableCcall(
            instance,
            "nlsPortableDebuggerGetBreakpoints",
            "string",
            ["string"],
            [String(file)],
          )) || '{"lines":[]}',
        );
      }),
    debuggerToggleBreakpoint: (file, line) =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall !== "function" ||
          typeof instance._nlsPortableDebuggerToggleBreakpoint !== "function"
        ) {
          return { file: String(file), lines: [] };
        }
        return JSON.parse(
          (await portableCcall(
            instance,
            "nlsPortableDebuggerToggleBreakpoint",
            "string",
            ["string", "number"],
            [String(file), Number(line) || 0],
          )) || '{"lines":[]}',
        );
      }),
    loadUserModules: (options = {}) =>
      enqueue(async () => {
        const instance = await initialize();
        if (options.beforeRun) await options.beforeRun(instance);
        let exitCode = 0;
        if (typeof instance._nlsPortableLoadUserModules === "function") {
          exitCode = await portableCcall(
            instance,
            "nlsPortableLoadUserModules",
            "number",
            [],
            [],
            { async: true },
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
          await portableCcall(instance, "nlsPortableReset", null, [], []);
        } else {
          instancePromise = undefined;
        }
      }),
    // Cooperative clock: advance due timers and drain pending callbacks on the
    // interpreter thread. Driven by a periodic timer in the worker so timer-based
    // GUIs (e.g. animation/UI timers) keep running while the engine is idle.
    pump: () =>
      enqueue(async () => {
        const instance = await initialize();
        if (
          typeof instance.ccall === "function" &&
          typeof instance._nlsPortablePump === "function"
        ) {
          await portableCcall(instance, "nlsPortablePump", null, [], [], {
            async: true,
          });
        }
      }),
  };
}
