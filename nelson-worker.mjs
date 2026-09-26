// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later
import { createPersistentNelsonRunner } from "./nelson-runtime.mjs";
import { createWorkspaceStore } from "./nelson-workspace-store.mjs";
import {
  createVisibleOutputFilter,
  evaluationCodeWithFigures,
  extractFigureFrames,
  extractUiActions,
  FIGURE_BEGIN,
  FIGURE_END,
  nelsonCharacterExpression,
  validateRuntimeCapabilityManifest,
  validateWorkerRequest,
} from "./nelson-worker-protocol.mjs";

const PROTOCOL_VERSION = 1;
const NFLOW_BEGIN = "__NFLOW_RESULT_BEGIN__";
const NFLOW_END = "__NFLOW_RESULT_END__";
const WORKSPACE_BEGIN = "__WORKSPACE_RESULT_BEGIN__";
const WORKSPACE_END = "__WORKSPACE_RESULT_END__";
const COMPLETION_BEGIN = "__COMPLETION_RESULT_BEGIN__";
const COMPLETION_END = "__COMPLETION_RESULT_END__";
const VARIABLE_BEGIN = "__VARIABLE_RESULT_BEGIN__";
const VARIABLE_END = "__VARIABLE_RESULT_END__";
const FIGURE_ACTION_BEGIN = "__FIGURE_ACTION_RESULT_BEGIN__";
const FIGURE_ACTION_END = "__FIGURE_ACTION_RESULT_END__";
let runner = null;
let runnerFactory = null;
let runnerOptions = null;
let nflowCancelSignal = null;
let virtualFiles = new Map();
let workspaceStore = createWorkspaceStore();

function progress(progress) {
  self.postMessage({ version: PROTOCOL_VERSION, event: "progress", progress });
}

function publishFigure(handle, json) {
  const displayList = JSON.parse(String(json));
  self.postMessage({
    version: PROTOCOL_VERSION,
    event: "figure",
    figure: { handle: Number(handle), displayList },
  });
}

function publishNFlowPartial(json) {
  self.postMessage({
    version: PROTOCOL_VERSION,
    event: "nflow.partial",
    partial: JSON.parse(String(json)),
  });
}

function reply(id, ok, value) {
  self.postMessage({
    version: PROTOCOL_VERSION,
    id,
    ok,
    ...(ok ? { result: value } : { error: String(value) }),
  });
}

function escapeNelsonCharacterVector(value) {
  return String(value).replaceAll("'", "''");
}

function extractMarkedResult(stdout, beginMarker, endMarker, label) {
  const begin = stdout.indexOf(beginMarker);
  const end = stdout.lastIndexOf(endMarker);
  if (begin < 0 || end < begin) {
    throw new Error(`${label} result markers are missing from Nelson output`);
  }
  return stdout.slice(begin + beginMarker.length, end).trim();
}

function runtimeCapabilityNames(manifest) {
  return [...validateRuntimeCapabilityManifest(manifest).capabilities];
}

async function initialize(
  moduleUrl,
  wasmBinary,
  runtimeCapabilities,
  nflowCancelBuffer
) {
  const capabilities = runtimeCapabilityNames(runtimeCapabilities);
  nflowCancelSignal = cancellationSignalFrom(nflowCancelBuffer);
  await restorePersistentWorkspace();
  const module = await import(moduleUrl);
  if (typeof module.default !== "function") {
    throw new TypeError(
      "The Nelson WebAssembly module has no default factory export"
    );
  }
  const runtimeBaseUrl = new URL(".", moduleUrl);
  runnerFactory = module.default;
  runnerOptions = {
    locateFile: (file) => new URL(file, runtimeBaseUrl).href,
    moduleOptions: {
      ...(wasmBinary ? { wasmBinary } : {}),
      setStatus: (label) => {
        const match = /\((\d+)\/(\d+)\)/.exec(String(label));
        progress({
          phase: "resources",
          label: String(label || "Loading runtime resources"),
          ...(match
            ? { loaded: Number(match[1]), total: Number(match[2]) }
            : {}),
        });
      },
      monitorRunDependencies: (remaining) =>
        progress({
          phase: "initializing",
          label: `Initializing runtime (${remaining} remaining)`,
        }),
      onNelsonFigureFrame: publishFigure,
      onNelsonNFlowPartial: publishNFlowPartial,
      onNelsonNFlowShouldCancel: () =>
        nflowCancelSignal ? Atomics.load(nflowCancelSignal, 0) : 0,
    },
  };
  runner = createPersistentNelsonRunner(runnerFactory, runnerOptions);
  const instance = await runner.initialize();
  if (
    capabilities.includes("portable-engine-api") &&
    typeof instance._nlsPortableEvaluate !== "function"
  ) {
    throw new Error("WebAssembly portable engine API is unavailable");
  }
  return { capabilities };
}

function cancellationSignalFrom(buffer) {
  if (
    typeof SharedArrayBuffer !== "function" ||
    !(buffer instanceof SharedArrayBuffer) ||
    buffer.byteLength < Int32Array.BYTES_PER_ELEMENT
  ) {
    return null;
  }
  return new Int32Array(buffer, 0, 1);
}

function normalizeVirtualPath(value) {
  const path = String(value).replaceAll("\\", "/");
  if (!path.startsWith("/workspace/") || path.split("/").includes("..")) {
    throw new Error("Virtual files must be below /workspace");
  }
  return path;
}

function disableWorkspacePersistence(error) {
  console.warn(
    `Nelson workspace persistence is unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  workspaceStore = createWorkspaceStore(undefined);
}

async function restorePersistentWorkspace() {
  if (!workspaceStore.available) return;
  try {
    virtualFiles = await workspaceStore.load();
  } catch (error) {
    disableWorkspacePersistence(error);
  }
}

async function persistVirtualFiles() {
  if (!workspaceStore.available) return;
  try {
    await workspaceStore.replace(virtualFiles);
  } catch (error) {
    disableWorkspacePersistence(error);
  }
}

function clearVirtualDirectory(module, directory) {
  for (const name of module.FS.readdir(directory)) {
    if (name === "." || name === "..") continue;
    const path = `${directory}/${name}`;
    const info = module.FS.stat(path);
    if (module.FS.isDir(info.mode)) {
      clearVirtualDirectory(module, path);
      module.FS.rmdir(path);
    } else {
      module.FS.unlink(path);
    }
  }
}

function populateVirtualFiles(module) {
  module.FS.mkdirTree("/workspace");
  module.FS.chdir("/");
  clearVirtualDirectory(module, "/workspace");
  for (const [path, data] of virtualFiles) {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/workspace";
    module.FS.mkdirTree(parent);
    module.FS.writeFile(path, data);
  }
  module.FS.chdir("/workspace");
}

async function collectVirtualFiles(module) {
  const collected = new Map();
  const visit = (directory) => {
    for (const name of module.FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const path = `${directory}/${name}`;
      const info = module.FS.stat(path);
      if (module.FS.isDir(info.mode)) visit(path);
      else collected.set(path, new Uint8Array(module.FS.readFile(path)));
    }
  };
  visit("/workspace");
  virtualFiles = collected;
  await persistVirtualFiles();
}

async function evaluateRaw(code, output = {}) {
  if (!runner) throw new Error("Nelson Worker is not initialized");
  const result = await runner.evaluate(String(code), {
    beforeRun: populateVirtualFiles,
    afterRun: collectVirtualFiles,
    print: output.stdout,
    printErr: output.stderr,
  });
  if (result.exitCode !== 0 || result.stderr.trim()) {
    const message =
      result.errorMessage ||
      result.stderr.trim() ||
      `Nelson exited with status ${result.exitCode}`;
    throw new Error(
      result.errorIdentifier ? `${result.errorIdentifier}: ${message}` : message
    );
  }
  return result;
}

async function evaluate(code, onOutput) {
  const outputFilter = createVisibleOutputFilter(onOutput);
  let result;
  try {
    result = await evaluateRaw(evaluationCodeWithFigures(String(code)), {
      stdout: (text) => outputFilter.push(text),
    });
  } finally {
    outputFilter.finish();
  }
  const figures = extractFigureFrames(result.stdout);
  const ui = extractUiActions(figures.stdout);
  return {
    ...result,
    stdout: outputFilter.emitted ? "" : ui.stdout,
    figures: figures.figures,
    uiActions: ui.actions,
  };
}

async function simulateNFlow(diagramJson) {
  const escaped = escapeNelsonCharacterVector(diagramJson);
  const code = [
    `nelsonWasmNflowResult = __nflow_simulate__('${escaped}');`,
    `disp(['${NFLOW_BEGIN}', nelsonWasmNflowResult, '${NFLOW_END}']);`,
    "clear nelsonWasmNflowResult;",
  ].join(" ");
  const result = await evaluateRaw(code);
  return JSON.parse(
    extractMarkedResult(result.stdout, NFLOW_BEGIN, NFLOW_END, "NFlow")
  );
}

async function listWorkspace() {
  const code = [
    "nelsonWasmWorkspace = whos();",
    `disp(['${WORKSPACE_BEGIN}', jsonencode(nelsonWasmWorkspace), '${WORKSPACE_END}']);`,
    "clear nelsonWasmWorkspace;",
  ].join("\n");
  const result = await evaluateRaw(code);
  const parsed = JSON.parse(
    extractMarkedResult(
      result.stdout,
      WORKSPACE_BEGIN,
      WORKSPACE_END,
      "Workspace"
    )
  );
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Object.keys(parsed).length
    ? [parsed]
    : [];
  return entries.filter(
    (entry) => !String(entry?.name ?? "").startsWith("nelsonWasm")
  );
}

async function complete(line) {
  const code = [
    `nelsonWasmCompletion = completion(${nelsonCharacterExpression(line)});`,
    `disp(['${COMPLETION_BEGIN}', jsonencode(nelsonWasmCompletion), '${COMPLETION_END}']);`,
    "clear nelsonWasmCompletion;",
  ].join("\n");
  const result = await evaluateRaw(code);
  return JSON.parse(
    extractMarkedResult(
      result.stdout,
      COMPLETION_BEGIN,
      COMPLETION_END,
      "Completion"
    )
  );
}

function validateVariableName(value) {
  const name = String(value);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid Nelson variable name: ${name}`);
  }
  return name;
}

async function readVariable(nameValue) {
  const name = validateVariableName(nameValue);
  const entries = await listWorkspace();
  const entry = entries.find((candidate) => candidate?.name === name);
  if (!entry) throw new Error(`Undefined variable '${name}'.`);
  const code = `disp(['${VARIABLE_BEGIN}', jsonencode(${name}), '${VARIABLE_END}']);`;
  const result = await evaluateRaw(code);
  return {
    name,
    entry,
    value: JSON.parse(
      extractMarkedResult(
        result.stdout,
        VARIABLE_BEGIN,
        VARIABLE_END,
        "Variable"
      )
    ),
  };
}

const numericClasses = new Set([
  "double",
  "single",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "logical",
]);

function variableMetadata({ name, entry, value }) {
  const dimensions = Array.isArray(entry?.size)
    ? entry.size.map(Number)
    : [1, 1];
  const rows = Number.isFinite(dimensions[0]) ? dimensions[0] : 1;
  const cols = Number.isFinite(dimensions[1]) ? dimensions[1] : 1;
  const className = String(entry?.class ?? "unknown");
  const twoDimensional = dimensions.length <= 2;
  const plain = !entry?.sparse && !entry?.complex && twoDimensional;
  let kind = "text";
  let editable = false;
  if (className === "char" && plain) {
    kind = "char";
    editable = true;
  } else if (className === "string" && plain) {
    kind = "string";
    editable = true;
  } else if (numericClasses.has(className) && plain) {
    kind = "matrix";
    editable = true;
  }
  return {
    name,
    className,
    rows: kind === "char" ? 1 : rows,
    cols: kind === "char" ? 1 : cols,
    columns: Array.from({ length: kind === "char" ? 1 : cols }, (_, index) =>
      String(index + 1)
    ),
    editable,
    kind,
    ...(kind === "text"
      ? { text: typeof value === "string" ? value : JSON.stringify(value) }
      : {}),
  };
}

function variableCells(descriptor) {
  const metadata = variableMetadata(descriptor);
  const { value } = descriptor;
  if (metadata.kind === "char") return [[String(value ?? "")]];
  if (metadata.kind === "string") {
    const flat = Array.isArray(value) ? value.flat(Infinity) : [value];
    return Array.from({ length: metadata.rows }, (_, row) =>
      Array.from(
        { length: metadata.cols },
        (_, col) => flat[row + col * metadata.rows] ?? ""
      )
    );
  }
  if (metadata.kind !== "matrix") return [[metadata.text ?? ""]];
  if (metadata.rows === 1 && metadata.cols === 1) return [[value]];
  if (Array.isArray(value) && Array.isArray(value[0])) return value;
  const flat = Array.isArray(value) ? value : [value];
  if (metadata.cols === 1) return flat.map((item) => [item]);
  return [flat];
}

async function openVariable(name) {
  return variableMetadata(await readVariable(name));
}

async function getVariableBlock(request) {
  const descriptor = await readVariable(request.name);
  const cells = variableCells(descriptor);
  const row0 = Math.max(0, Number(request.row0) || 0);
  const col0 = Math.max(0, Number(request.col0) || 0);
  const rows = Math.max(0, Number(request.rows) || 0);
  const cols = Math.max(0, Number(request.cols) || 0);
  return {
    row0,
    col0,
    cells: cells
      .slice(row0, row0 + rows)
      .map((row) => row.slice(col0, col0 + cols)),
  };
}

function characterExpression(value) {
  return nelsonCharacterExpression(String(value ?? ""));
}

function numericLiteral(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "NaN";
  const number = Number(value);
  if (Number.isNaN(number)) return "NaN";
  if (number === Infinity) return "Inf";
  if (number === -Infinity) return "-Inf";
  return String(number);
}

function matrixExpression(values, render) {
  if (!Array.isArray(values) || values.length === 0) return "[]";
  return `[${values.map((row) => row.map(render).join(", ")).join("; ")}]`;
}

async function replaceVariable(nameValue, values) {
  const descriptor = await readVariable(nameValue);
  const metadata = variableMetadata(descriptor);
  if (!metadata.editable) throw new Error(`Cannot edit '${descriptor.name}'.`);
  let expression;
  if (metadata.kind === "char") {
    expression = characterExpression(values?.[0]?.[0] ?? "");
  } else if (metadata.kind === "string") {
    expression = matrixExpression(
      values,
      (value) => `string(${characterExpression(value)})`
    );
  } else {
    expression = matrixExpression(values, numericLiteral);
    if (metadata.className !== "double" && metadata.className !== "logical") {
      expression = `${metadata.className}(${expression})`;
    }
    if (metadata.className === "logical") expression = `logical(${expression})`;
  }
  await evaluateRaw(`${descriptor.name} = ${expression};`);
  return { ok: true };
}

async function setFigureView(handle, azimuth, elevation, compactView = false) {
  const figureHandle = Number(handle);
  const az = Number(azimuth);
  const el = Number(elevation);
  if (!Number.isSafeInteger(figureHandle) || figureHandle < 0) {
    throw new Error("Invalid WebAssembly figure handle");
  }
  if (!Number.isFinite(az) || !Number.isFinite(el)) {
    throw new Error("Invalid WebAssembly figure view");
  }
  const code = [
    `nelsonWasmViewFrame = __web_display_list__(${figureHandle}, ${az}, ${el}, ${
      compactView ? "true" : "false"
    });`,
    `disp(['${FIGURE_BEGIN}', nelsonWasmViewFrame, '${FIGURE_END}']);`,
    "clear nelsonWasmViewFrame;",
  ].join("\n");
  const result = await evaluateRaw(code);
  const frame = extractFigureFrames(result.stdout).figures[0];
  if (!frame) throw new Error("Updated figure frame is missing");
  return { ...frame.displayList, handle: figureHandle };
}

async function evaluateFigureAction(statement, resultExpression) {
  const code = [
    statement,
    `nelsonWasmFigureActionResult = ${resultExpression};`,
    `disp(['${FIGURE_ACTION_BEGIN}', jsonencode(nelsonWasmFigureActionResult), '${FIGURE_ACTION_END}']);`,
    "clear nelsonWasmFigureActionResult nelsonWasmFigureActionOk nelsonWasmFigureMotion;",
  ].join("\n");
  const result = await evaluateRaw(evaluationCodeWithFigures(code));
  const extracted = extractFigureFrames(result.stdout);
  return {
    ...JSON.parse(
      extractMarkedResult(
        extracted.stdout,
        FIGURE_ACTION_BEGIN,
        FIGURE_ACTION_END,
        "Figure action"
      )
    ),
    figures: extracted.figures,
  };
}

async function setFigureSize(handle, width, height) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_size__(${Number(handle)}, ${Number(
      width
    )}, ${Number(height)});`,
    "struct('ok', nelsonWasmFigureActionOk)"
  );
}

async function panFigure(handle, dxFrac, dyFrac) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_pan__(${Number(handle)}, ${Number(
      dxFrac
    )}, ${Number(dyFrac)});`,
    "struct('ok', nelsonWasmFigureActionOk)"
  );
}

async function closeFigure(handle) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_close__(${Number(handle)});`,
    "struct('ok', nelsonWasmFigureActionOk)"
  );
}

async function sendFigureKeyEvent(request) {
  const logical = (value) => (value ? "true" : "false");
  const args = [
    Number(request.handle),
    logical(request.pressed),
    nelsonCharacterExpression(request.character),
    nelsonCharacterExpression(request.key),
    logical(request.shift),
    logical(request.control),
    logical(request.alt),
    logical(request.meta),
  ].join(", ");
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_key_event__(${args});`,
    "struct('ok', nelsonWasmFigureActionOk)"
  );
}

async function sendFigureMouseEvent(request) {
  return evaluateFigureAction(
    `[nelsonWasmFigureActionOk, nelsonWasmFigureMotion] = __figure_mouse_event__(${Number(
      request.handle
    )}, ${nelsonCharacterExpression(request.action)}, [${Number(
      request.x
    )} ${Number(request.y)}], 'web');`,
    "struct('ok', nelsonWasmFigureActionOk, 'motion', nelsonWasmFigureMotion)"
  );
}

async function sendUIControlAction(request) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_uicontrol_action__(${Number(
      request.handle
    )}, ${Number(request.value)}, ${nelsonCharacterExpression(request.text)});`,
    "struct('ok', nelsonWasmFigureActionOk)"
  );
}

async function writeVirtualFile(path, data) {
  const normalized = normalizeVirtualPath(path);
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  virtualFiles.set(normalized, bytes);
  await persistVirtualFiles();
  return { path: normalized, bytes: bytes.byteLength };
}

function readVirtualFile(path) {
  const normalized = normalizeVirtualPath(path);
  const data = virtualFiles.get(normalized);
  if (!data) throw new Error(`Virtual file does not exist: ${normalized}`);
  return { path: normalized, data };
}

self.addEventListener("message", async (event) => {
  const request = event.data || {};
  if (request.version !== PROTOCOL_VERSION || !Number.isInteger(request.id)) {
    return;
  }

  try {
    validateWorkerRequest(request);
    let result;
    switch (request.type) {
      case "init":
        result = await initialize(
          String(request.moduleUrl),
          request.wasmBinary,
          request.runtimeCapabilities,
          request.nflowCancelBuffer
        );
        break;
      case "evaluate":
        result = await evaluate(String(request.code ?? ""), (text) =>
          self.postMessage({
            version: PROTOCOL_VERSION,
            event: "output",
            id: request.id,
            output: { stream: "stdout", text },
          })
        );
        break;
      case "nflow.simulate":
        result = await simulateNFlow(String(request.diagramJson ?? "{}"));
        break;
      case "file.write":
        result = await writeVirtualFile(request.path, request.data);
        break;
      case "file.read":
        result = readVirtualFile(request.path);
        break;
      case "file.list":
        result = [...virtualFiles.keys()].sort();
        break;
      case "workspace.list":
        result = await listWorkspace();
        break;
      case "variable.open":
        result = await openVariable(request.name);
        break;
      case "variable.block":
        result = await getVariableBlock(request);
        break;
      case "variable.replace":
        result = await replaceVariable(request.name, request.values);
        break;
      case "completion.request":
        result = await complete(String(request.line ?? ""));
        break;
      case "figure.setView":
        result = await setFigureView(
          request.handle,
          request.azimuth,
          request.elevation,
          request.compactView
        );
        break;
      case "figure.setSize":
        result = await setFigureSize(
          request.handle,
          request.width,
          request.height
        );
        break;
      case "figure.pan":
        result = await panFigure(
          request.handle,
          request.dxFrac,
          request.dyFrac
        );
        break;
      case "figure.close":
        result = await closeFigure(request.handle);
        break;
      case "figure.keyEvent":
        result = await sendFigureKeyEvent(request);
        break;
      case "figure.mouseEvent":
        result = await sendFigureMouseEvent(request);
        break;
      case "uicontrol.action":
        result = await sendUIControlAction(request);
        break;
      case "reset":
        virtualFiles.clear();
        if (workspaceStore.available) {
          try {
            await workspaceStore.clear();
          } catch (error) {
            disableWorkspacePersistence(error);
          }
        }
        await runner.reset();
        result = { reset: true };
        break;
      default:
        throw new Error(
          `Unsupported Nelson Worker request: ${String(request.type)}`
        );
    }
    reply(request.id, true, result);
  } catch (error) {
    reply(request.id, false, error instanceof Error ? error.message : error);
  }
});
