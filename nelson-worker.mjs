// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later
import { createPersistentNelsonRunner } from "./nelson-runtime.mjs?build=fb2eb22a078c";
import { createWorkspaceStore } from "./nelson-workspace-store.mjs?build=fb2eb22a078c";
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
  versionedSiblingUrl,
} from "./nelson-worker-protocol.mjs?build=fb2eb22a078c";

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
let commandMailbox = null;
let virtualFiles = new Map();
let virtualDirectories = new Set();
let workspaceStore = createWorkspaceStore();
const PERSISTENT_DIRECTORIES = ["/workspace", "/preferences", "/user-modules"];

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
  nflowCancelBuffer,
  commandBuffer,
) {
  const capabilities = runtimeCapabilityNames(runtimeCapabilities);
  nflowCancelSignal = cancellationSignalFrom(nflowCancelBuffer);
  commandMailbox = commandMailboxFrom(commandBuffer);
  await restorePersistentWorkspace();
  const module = await import(moduleUrl);
  if (typeof module.default !== "function") {
    throw new TypeError(
      "The Nelson WebAssembly module has no default factory export",
    );
  }
  runnerFactory = module.default;
  runnerOptions = {
    locateFile: (file) => versionedSiblingUrl(file, moduleUrl),
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
      onNelsonPollCommand: pollCooperativeCommand,
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
  if (capabilities.includes("package-manager-core")) {
    const loaded = await runner.loadUserModules({
      beforeRun: populateVirtualFiles,
      afterRun: collectVirtualFiles,
    });
    if (loaded.exitCode !== 0) {
      throw new Error("Installed Nelson modules could not be loaded");
    }
  }
  return { capabilities };
}

function commandMailboxFrom(buffer) {
  if (
    typeof SharedArrayBuffer !== "function" ||
    !(buffer instanceof SharedArrayBuffer) ||
    buffer.byteLength <= Int32Array.BYTES_PER_ELEMENT * 2
  ) {
    return null;
  }
  return {
    header: new Int32Array(buffer, 0, 2),
    payload: new Uint8Array(buffer, Int32Array.BYTES_PER_ELEMENT * 2),
  };
}

function pollCooperativeCommand() {
  if (!commandMailbox || Atomics.load(commandMailbox.header, 0) !== 1) {
    return "";
  }
  const length = Atomics.load(commandMailbox.header, 1);
  let command = "";
  if (length > 0 && length <= commandMailbox.payload.byteLength) {
    // Chromium deliberately rejects TextDecoder input backed directly by a
    // SharedArrayBuffer. Copy only the occupied mailbox bytes to a regular
    // ArrayBuffer before decoding the cooperative command.
    const bytes = new Uint8Array(commandMailbox.payload.subarray(0, length));
    command = new TextDecoder().decode(bytes);
  }
  Atomics.store(commandMailbox.header, 1, 0);
  Atomics.store(commandMailbox.header, 0, 0);
  self.postMessage({
    version: PROTOCOL_VERSION,
    event: "command.consumed",
  });
  return command;
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

function parentVirtualPath(path) {
  return path.slice(0, path.lastIndexOf("/")) || "/workspace";
}

function addParentDirectories(path) {
  let parent = parentVirtualPath(path);
  while (parent.startsWith("/workspace/") && parent !== "/workspace") {
    virtualDirectories.add(parent);
    parent = parentVirtualPath(parent);
  }
}

function disableWorkspacePersistence(error) {
  console.warn(
    `Nelson workspace persistence is unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  workspaceStore = createWorkspaceStore(undefined);
}

async function restorePersistentWorkspace() {
  if (!workspaceStore.available) return;
  try {
    const restored = await workspaceStore.loadWorkspace();
    virtualFiles = restored.files;
    virtualDirectories = restored.directories;
    for (const path of virtualFiles.keys()) addParentDirectories(path);
  } catch (error) {
    disableWorkspacePersistence(error);
  }
}

async function persistVirtualFiles() {
  if (!workspaceStore.available) return;
  try {
    await workspaceStore.replaceWorkspace(virtualFiles, virtualDirectories);
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
  module.FS.chdir("/");
  for (const directory of PERSISTENT_DIRECTORIES) {
    module.FS.mkdirTree(directory);
    clearVirtualDirectory(module, directory);
  }
  for (const directory of [...virtualDirectories].sort(
    (left, right) => left.length - right.length,
  )) {
    module.FS.mkdirTree(directory);
  }
  for (const [path, data] of virtualFiles) {
    const parent = parentVirtualPath(path);
    module.FS.mkdirTree(parent);
    module.FS.writeFile(path, data);
  }
  module.FS.chdir("/workspace");
}

async function collectVirtualFiles(module) {
  const collected = new Map();
  const directories = new Set();
  const visit = (directory) => {
    for (const name of module.FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const path = `${directory}/${name}`;
      const info = module.FS.stat(path);
      if (module.FS.isDir(info.mode)) {
        directories.add(path);
        visit(path);
      }
      else collected.set(path, new Uint8Array(module.FS.readFile(path)));
    }
  };
  for (const directory of PERSISTENT_DIRECTORIES) visit(directory);
  virtualFiles = collected;
  virtualDirectories = directories;
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
      result.errorIdentifier
        ? `${result.errorIdentifier}: ${message}`
        : message,
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
    `nelsonWasmNflowDocument = NFlow.internal.prepareModelJson('${escaped}');`,
    "nelsonWasmNflowResult = __nflow_simulate__(nelsonWasmNflowDocument);",
    `disp(['${NFLOW_BEGIN}', nelsonWasmNflowResult, '${NFLOW_END}']);`,
    "clear nelsonWasmNflowDocument nelsonWasmNflowResult;",
  ].join(" ");
  const result = await evaluateRaw(code);
  return JSON.parse(
    extractMarkedResult(result.stdout, NFLOW_BEGIN, NFLOW_END, "NFlow"),
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
      "Workspace",
    ),
  );
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Object.keys(parsed).length
      ? [parsed]
      : [];
  return entries.filter(
    (entry) => !String(entry?.name ?? "").startsWith("nelsonWasm"),
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
      "Completion",
    ),
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
        "Variable",
      ),
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
  } else if (className === "struct" && plain) {
    kind = "struct";
  } else if (className === "cell" && plain) {
    kind = "cell";
  }
  const structValues =
    kind === "struct" ? (Array.isArray(value) ? value : [value]) : [];
  const fields =
    kind === "struct" && structValues[0] && typeof structValues[0] === "object"
      ? Object.keys(structValues[0])
      : [];
  const gridRows = kind === "struct" ? rows * cols : kind === "char" ? 1 : rows;
  const gridCols = kind === "struct" ? fields.length : kind === "char" ? 1 : cols;
  return {
    name,
    className,
    rows: gridRows,
    cols: gridCols,
    columns:
      kind === "struct"
        ? fields
        : Array.from({ length: gridCols }, (_, index) => String(index + 1)),
    editable,
    kind,
    ...(kind === "text"
      ? { text: typeof value === "string" ? value : JSON.stringify(value) }
      : {}),
  };
}

function summarizeNestedValue(value) {
  if (value === null || value === undefined) return "[]";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const rows = Array.isArray(value[0]) ? value.length : 1;
    const cols = Array.isArray(value[0]) ? value[0].length : value.length;
    return `${rows}x${cols} value`;
  }
  if (typeof value === "object") return "1x1 struct";
  return String(value);
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
        (_, col) => flat[row + col * metadata.rows] ?? "",
      ),
    );
  }
  if (metadata.kind === "struct") {
    const values = Array.isArray(value) ? value : [value];
    return values.map((element) =>
      metadata.columns.map((field) => summarizeNestedValue(element?.[field])),
    );
  }
  if (metadata.kind === "cell") {
    const values = Array.isArray(value) ? value : [value];
    return Array.from({ length: metadata.rows }, (_, row) =>
      Array.from({ length: metadata.cols }, (_, col) =>
        summarizeNestedValue(values[row + col * metadata.rows]),
      ),
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
      (value) => `string(${characterExpression(value)})`,
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

function nestedAssignmentTarget(descriptor, kind, row, col) {
  const metadata = variableMetadata(descriptor);
  if (metadata.kind !== kind || row >= metadata.rows || col >= metadata.cols) {
    throw new Error(`Invalid nested cell for '${descriptor.name}'.`);
  }
  if (kind === "cell") return `${descriptor.name}{${row + 1}, ${col + 1}}`;
  const field = metadata.columns[col];
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
    throw new Error(`Unsupported struct field: ${field}`);
  }
  return `${descriptor.name}(${row + 1}).${field}`;
}

async function setNestedVariable(request) {
  const descriptor = await readVariable(request.name);
  const kind = String(request.kind);
  const row = Number(request.row);
  const col = Number(request.col);
  const target = nestedAssignmentTarget(descriptor, kind, row, col);
  const text = String(request.value ?? "");
  const parsed = Number.parseFloat(text);
  const numeric = Number.isNaN(parsed) ? "0" : numericLiteral(parsed);
  const character = characterExpression(text);
  await evaluateRaw(
    [
      `nelsonWasmNestedValue = ${target};`,
      "if ischar(nelsonWasmNestedValue)",
      `  ${target} = ${character};`,
      "elseif isstring(nelsonWasmNestedValue)",
      `  ${target} = string(${character});`,
      "elseif isnumeric(nelsonWasmNestedValue) || islogical(nelsonWasmNestedValue)",
      `  ${target} = feval(class(nelsonWasmNestedValue), ${numeric});`,
      "else",
      "  error('Nelson:web_gui:unsupportedNestedEdit', " +
        "'only scalar numeric, char, and string cells are editable');",
      "end",
      "clear nelsonWasmNestedValue;",
    ].join("\n"),
  );
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
        "Figure action",
      ),
    ),
    figures: extracted.figures,
  };
}

async function setFigureSize(handle, width, height) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_size__(${Number(handle)}, ${Number(
      width,
    )}, ${Number(height)});`,
    "struct('ok', nelsonWasmFigureActionOk)",
  );
}

async function panFigure(handle, dxFrac, dyFrac) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_pan__(${Number(handle)}, ${Number(
      dxFrac,
    )}, ${Number(dyFrac)});`,
    "struct('ok', nelsonWasmFigureActionOk)",
  );
}

async function closeFigure(handle) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_figure_close__(${Number(handle)});`,
    "struct('ok', nelsonWasmFigureActionOk)",
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
    "struct('ok', nelsonWasmFigureActionOk)",
  );
}

async function sendFigureMouseEvent(request) {
  return evaluateFigureAction(
    `[nelsonWasmFigureActionOk, nelsonWasmFigureMotion] = __figure_mouse_event__(${Number(
      request.handle,
    )}, ${nelsonCharacterExpression(request.action)}, [${Number(
      request.x,
    )} ${Number(request.y)}], 'web');`,
    "struct('ok', nelsonWasmFigureActionOk, 'motion', nelsonWasmFigureMotion)",
  );
}

async function sendUIControlAction(request) {
  return evaluateFigureAction(
    `nelsonWasmFigureActionOk = __web_uicontrol_action__(${Number(
      request.handle,
    )}, ${Number(request.value)}, ${nelsonCharacterExpression(request.text)});`,
    "struct('ok', nelsonWasmFigureActionOk)",
  );
}

function desktopCodeAnalyzerDiagnostics(diagnostics) {
  return diagnostics
    .filter((diagnostic) => !diagnostic.suppressed)
    .map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      ruleName: diagnostic.ruleName,
      checkId: diagnostic.id,
      category: diagnostic.category,
      helpUri: diagnostic.helpUri,
      lineStart: diagnostic.range?.startLine ?? diagnostic.line ?? 0,
      lineEnd: diagnostic.range?.endLine ?? diagnostic.line ?? 0,
      columnStart: diagnostic.range?.startColumn ?? diagnostic.column ?? 0,
      columnEnd: diagnostic.range?.endColumn ?? diagnostic.column ?? 0,
      fixes: (diagnostic.fixes || []).map((fix) => ({
        title: fix.title,
        safe: fix.safe,
        edits: (fix.edits || []).map((edit) => ({
          lineStart: edit.range?.startLine ?? 0,
          lineEnd: edit.range?.endLine ?? 0,
          columnStart: edit.range?.startColumn ?? 0,
          columnEnd: edit.range?.endColumn ?? 0,
          replacementText: edit.replacementText,
        })),
      })),
    }));
}

async function writeVirtualFile(path, data) {
  const normalized = normalizeVirtualPath(path);
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  virtualFiles.set(normalized, bytes);
  addParentDirectories(normalized);
  await persistVirtualFiles();
  return { path: normalized, bytes: bytes.byteLength };
}

async function createVirtualDirectory(path) {
  const normalized = normalizeVirtualPath(path);
  if (virtualFiles.has(normalized) || virtualDirectories.has(normalized)) {
    throw new Error(`Virtual path already exists: ${normalized}`);
  }
  addParentDirectories(normalized);
  virtualDirectories.add(normalized);
  await persistVirtualFiles();
  return { ok: true, path: normalized };
}

function virtualPathExists(path) {
  return virtualFiles.has(path) || virtualDirectories.has(path);
}

async function renameVirtualPath(fromValue, toValue) {
  const from = normalizeVirtualPath(fromValue);
  const to = normalizeVirtualPath(toValue);
  if (!virtualPathExists(from)) throw new Error(`Virtual path does not exist: ${from}`);
  if (virtualPathExists(to)) throw new Error(`Virtual path already exists: ${to}`);
  if (to.startsWith(`${from}/`)) throw new Error("Cannot move a directory inside itself");
  if (virtualFiles.has(from)) {
    const data = virtualFiles.get(from);
    virtualFiles.delete(from);
    virtualFiles.set(to, data);
  } else {
    const movedFiles = [...virtualFiles.entries()].filter(([path]) =>
      path.startsWith(`${from}/`),
    );
    const movedDirectories = [...virtualDirectories].filter(
      (path) => path === from || path.startsWith(`${from}/`),
    );
    for (const [path] of movedFiles) virtualFiles.delete(path);
    for (const path of movedDirectories) virtualDirectories.delete(path);
    for (const [path, data] of movedFiles) {
      virtualFiles.set(`${to}${path.slice(from.length)}`, data);
    }
    for (const path of movedDirectories) {
      virtualDirectories.add(`${to}${path.slice(from.length)}`);
    }
  }
  addParentDirectories(to);
  await persistVirtualFiles();
  return { ok: true, path: to };
}

async function deleteVirtualPath(pathValue) {
  const path = normalizeVirtualPath(pathValue);
  let removed = virtualFiles.delete(path);
  for (const file of [...virtualFiles.keys()]) {
    if (file.startsWith(`${path}/`)) {
      virtualFiles.delete(file);
      removed = true;
    }
  }
  for (const directory of [...virtualDirectories]) {
    if (directory === path || directory.startsWith(`${path}/`)) {
      virtualDirectories.delete(directory);
      removed = true;
    }
  }
  if (!removed) throw new Error(`Virtual path does not exist: ${path}`);
  await persistVirtualFiles();
  return { ok: true };
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
          request.nflowCancelBuffer,
          request.commandBuffer,
        );
        break;
      case "evaluate":
        result = await evaluate(String(request.code ?? ""), (text) =>
          self.postMessage({
            version: PROTOCOL_VERSION,
            event: "output",
            id: request.id,
            output: { stream: "stdout", text },
          }),
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
      case "directory.list":
        result = [...virtualDirectories].sort();
        break;
      case "file.mkdir":
        result = await createVirtualDirectory(request.path);
        break;
      case "file.rename":
        result = await renameVirtualPath(request.from, request.to);
        break;
      case "file.delete":
        result = await deleteVirtualPath(request.path);
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
      case "variable.setNested":
        result = await setNestedVariable(request);
        break;
      case "completion.request":
        result = await complete(String(request.line ?? ""));
        break;
      case "code.analyze":
        result = {
          diagnostics: desktopCodeAnalyzerDiagnostics(
            await runner.analyzeCode(request.path, request.source),
          ),
        };
        break;
      case "figure.setView":
        result = await setFigureView(
          request.handle,
          request.azimuth,
          request.elevation,
          request.compactView,
        );
        break;
      case "figure.setSize":
        result = await setFigureSize(
          request.handle,
          request.width,
          request.height,
        );
        break;
      case "figure.pan":
        result = await panFigure(
          request.handle,
          request.dxFrac,
          request.dyFrac,
        );
        break;
      case "figure.close":
        result = await closeFigure(request.handle);
        break;
      case "figure.getImage":
        result = {
          handle: request.handle,
          image: `data:image/png;base64,${await runner.renderFigurePng(request.handle)}`,
        };
        break;
      case "figure.saveAs": {
        const path = normalizeVirtualPath(request.path);
        result = await runner.saveFigure(request.handle, path, {
          beforeRun: populateVirtualFiles,
          afterRun: collectVirtualFiles,
        });
        break;
      }
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
        virtualDirectories.clear();
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
          `Unsupported Nelson Worker request: ${String(request.type)}`,
        );
    }
    reply(request.id, true, result);
  } catch (error) {
    reply(request.id, false, error instanceof Error ? error.message : error);
  }
});
