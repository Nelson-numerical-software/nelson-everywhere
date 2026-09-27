// Copyright (c) 2026-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

export const FIGURE_BEGIN = "__NELSON_FIGURE_BEGIN__";
export const FIGURE_END = "__NELSON_FIGURE_END__";
export const UI_ACTION_BEGIN = "__NELSON_UI_ACTION_BEGIN__";
export const UI_ACTION_END = "__NELSON_UI_ACTION_END__";
export const WORKER_LIMITS = Object.freeze({
  maxNflowJsonBytes: 8 * 1024 * 1024,
  maxSourceBytes: 4 * 1024 * 1024,
  maxVariableBlockCells: 1_000_000,
  maxVirtualFileBytes: 32 * 1024 * 1024,
  maxWasmBytes: 128 * 1024 * 1024,
});

export function versionedSiblingUrl(path, baseHref) {
  const base = new URL(baseHref);
  const url = new URL(path, base);
  const buildId = base.searchParams.get("build");
  if (buildId && url.origin === base.origin && !url.searchParams.has("build")) {
    url.searchParams.set("build", buildId);
  }
  return url.href;
}

const REQUEST_TYPES = new Set([
  "code.analyze",
  "completion.request",
  "evaluate",
  "figure.close",
  "figure.getImage",
  "figure.keyEvent",
  "figure.mouseEvent",
  "figure.pan",
  "figure.saveAs",
  "figure.setSize",
  "figure.setView",
  "file.list",
  "file.read",
  "file.delete",
  "file.mkdir",
  "file.rename",
  "directory.list",
  "file.write",
  "init",
  "nflow.simulate",
  "reset",
  "variable.block",
  "variable.setNested",
  "variable.open",
  "variable.replace",
  "uicontrol.action",
  "workspace.list",
]);

const CAPABILITY_FEATURES = [
  "blas",
  "controlSystem",
  "lapack",
  "nflow",
  "odeSolvers",
  "packageManager",
  "plots",
  "slicot",
  "virtualFilesystem",
  "worker",
];

export function validateRuntimeCapabilityManifest(manifest) {
  const stringArray = (value) =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  if (
    !manifest ||
    manifest.formatVersion !== 1 ||
    manifest.runtime !== "webassembly" ||
    typeof manifest.profile !== "string" ||
    !stringArray(manifest.modules) ||
    !stringArray(manifest.capabilities) ||
    !stringArray(manifest.unavailable) ||
    CAPABILITY_FEATURES.some(
      (name) => typeof manifest.features?.[name] !== "boolean",
    ) ||
    Object.entries(WORKER_LIMITS).some(
      ([name, value]) => manifest.limits?.[name] !== value,
    )
  ) {
    throw new Error("Invalid WebAssembly capability manifest");
  }
  return manifest;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function binaryBytes(value) {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return -1;
}

function assertStringByteLimit(value, limit, label) {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  if (utf8Bytes(value) > limit) {
    throw new Error(`${label} exceeds the ${limit}-byte WebAssembly limit`);
  }
}

function matrixCellCount(value) {
  if (!Array.isArray(value)) return -1;
  return value.reduce(
    (count, row) => count + (Array.isArray(row) ? row.length : 0),
    0,
  );
}

export function validateWorkerRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("Nelson Worker request must be an object");
  }
  if (!REQUEST_TYPES.has(request.type)) {
    throw new Error(
      `Unsupported Nelson Worker request: ${String(request.type)}`,
    );
  }
  switch (request.type) {
    case "init": {
      if (
        typeof request.moduleUrl !== "string" ||
        !request.runtimeCapabilities
      ) {
        throw new Error("WebAssembly initialization payload is incomplete");
      }
      if (request.wasmBinary !== undefined) {
        const bytes = binaryBytes(request.wasmBinary);
        if (bytes < 0 || bytes > WORKER_LIMITS.maxWasmBytes) {
          throw new Error(
            `WebAssembly binary exceeds the ${WORKER_LIMITS.maxWasmBytes}-byte limit`,
          );
        }
      }
      if (
        request.nflowCancelBuffer !== undefined &&
        (typeof SharedArrayBuffer !== "function" ||
          !(request.nflowCancelBuffer instanceof SharedArrayBuffer) ||
          request.nflowCancelBuffer.byteLength < Int32Array.BYTES_PER_ELEMENT)
      ) {
        throw new Error("Invalid NFlow cooperative cancellation buffer");
      }
      if (
        request.commandBuffer !== undefined &&
        (typeof SharedArrayBuffer !== "function" ||
          !(request.commandBuffer instanceof SharedArrayBuffer) ||
          request.commandBuffer.byteLength <= Int32Array.BYTES_PER_ELEMENT * 2)
      ) {
        throw new Error("Invalid cooperative command buffer");
      }
      break;
    }
    case "evaluate":
      assertStringByteLimit(
        request.code,
        WORKER_LIMITS.maxSourceBytes,
        "Source code",
      );
      break;
    case "completion.request":
      assertStringByteLimit(
        request.line,
        WORKER_LIMITS.maxSourceBytes,
        "Completion input",
      );
      break;
    case "code.analyze":
      assertStringByteLimit(
        request.path,
        WORKER_LIMITS.maxSourceBytes,
        "Code analyzer path",
      );
      assertStringByteLimit(
        request.source,
        WORKER_LIMITS.maxSourceBytes,
        "Code analyzer source",
      );
      break;
    case "figure.close":
    case "figure.getImage":
    case "figure.setView": {
      if (!Number.isSafeInteger(request.handle) || request.handle < 0) {
        throw new Error("Invalid WebAssembly figure handle");
      }
      break;
    }
    case "figure.setSize": {
      if (
        !Number.isSafeInteger(request.handle) ||
        request.handle < 0 ||
        !Number.isSafeInteger(request.width) ||
        !Number.isSafeInteger(request.height) ||
        request.width <= 0 ||
        request.height <= 0
      ) {
        throw new Error("Invalid WebAssembly figure size");
      }
      break;
    }
    case "figure.pan": {
      if (
        !Number.isSafeInteger(request.handle) ||
        request.handle < 0 ||
        !Number.isFinite(request.dxFrac) ||
        !Number.isFinite(request.dyFrac)
      ) {
        throw new Error("Invalid WebAssembly figure pan");
      }
      break;
    }
    case "figure.saveAs": {
      if (!Number.isSafeInteger(request.handle) || request.handle < 0) {
        throw new Error("Invalid WebAssembly figure handle");
      }
      assertStringByteLimit(
        request.path,
        WORKER_LIMITS.maxSourceBytes,
        "Figure export path",
      );
      break;
    }
    case "figure.keyEvent": {
      if (
        !Number.isSafeInteger(request.handle) ||
        request.handle < 0 ||
        typeof request.pressed !== "boolean" ||
        typeof request.character !== "string" ||
        typeof request.key !== "string" ||
        typeof request.shift !== "boolean" ||
        typeof request.control !== "boolean" ||
        typeof request.alt !== "boolean" ||
        typeof request.meta !== "boolean"
      ) {
        throw new Error("Invalid WebAssembly figure key event");
      }
      break;
    }
    case "figure.mouseEvent": {
      if (
        !Number.isSafeInteger(request.handle) ||
        request.handle < 0 ||
        !["press", "motion", "release"].includes(request.action) ||
        !Number.isFinite(request.x) ||
        !Number.isFinite(request.y)
      ) {
        throw new Error("Invalid WebAssembly figure mouse event");
      }
      break;
    }
    case "uicontrol.action": {
      if (
        !Number.isSafeInteger(request.handle) ||
        request.handle < 0 ||
        !Number.isFinite(request.value) ||
        typeof request.text !== "string"
      ) {
        throw new Error("Invalid WebAssembly UI control action");
      }
      break;
    }
    case "nflow.simulate":
      assertStringByteLimit(
        request.diagramJson,
        WORKER_LIMITS.maxNflowJsonBytes,
        "NFlow model",
      );
      break;
    case "file.write": {
      const bytes = binaryBytes(request.data);
      if (bytes < 0) throw new Error("Virtual file data must be binary");
      if (bytes > WORKER_LIMITS.maxVirtualFileBytes) {
        throw new Error(
          `Virtual file exceeds the ${WORKER_LIMITS.maxVirtualFileBytes}-byte limit`,
        );
      }
      break;
    }
    case "file.read":
    case "file.delete":
    case "file.mkdir": {
      assertStringByteLimit(
        request.path,
        WORKER_LIMITS.maxSourceBytes,
        "Virtual path",
      );
      break;
    }
    case "file.rename": {
      assertStringByteLimit(
        request.from,
        WORKER_LIMITS.maxSourceBytes,
        "Source virtual path",
      );
      assertStringByteLimit(
        request.to,
        WORKER_LIMITS.maxSourceBytes,
        "Target virtual path",
      );
      break;
    }
    case "variable.block": {
      const rows = Number(request.rows);
      const cols = Number(request.cols);
      if (
        !Number.isSafeInteger(rows) ||
        !Number.isSafeInteger(cols) ||
        rows < 0 ||
        cols < 0 ||
        rows * cols > WORKER_LIMITS.maxVariableBlockCells
      ) {
        throw new Error("Variable block exceeds the WebAssembly cell limit");
      }
      break;
    }
    case "variable.replace": {
      const cells = matrixCellCount(request.values);
      if (cells < 0 || cells > WORKER_LIMITS.maxVariableBlockCells) {
        throw new Error(
          "Variable replacement exceeds the WebAssembly cell limit",
        );
      }
      break;
    }
    case "variable.setNested": {
      if (
        !["struct", "cell"].includes(request.kind) ||
        !Number.isSafeInteger(request.row) ||
        !Number.isSafeInteger(request.col) ||
        request.row < 0 ||
        request.col < 0
      ) {
        throw new Error("Invalid nested WebAssembly variable cell");
      }
      assertStringByteLimit(
        request.value,
        WORKER_LIMITS.maxSourceBytes,
        "Nested variable value",
      );
      break;
    }
  }
  return request;
}

export function evaluationCodeWithFigures(code) {
  return [
    String(code),
    "if isbuiltin('__web_display_list__')",
    "  nelsonWasmFigures = findall(0, 'Type', 'figure');",
    "  for nelsonWasmFigureIndex = 1:numel(nelsonWasmFigures)",
    "    nelsonWasmDisplayList = __web_display_list__(nelsonWasmFigures(nelsonWasmFigureIndex));",
    `    disp(['${FIGURE_BEGIN}', nelsonWasmDisplayList, '${FIGURE_END}']);`,
    "  end",
    "  clear nelsonWasmFigures nelsonWasmFigureIndex nelsonWasmDisplayList;",
    "end",
  ].join("\n");
}

function characterCodes(value) {
  return [...String(value)]
    .map((character) => character.codePointAt(0))
    .join(" ");
}

export function nelsonCharacterExpression(value) {
  return `char([${characterCodes(value)}])`;
}

export function extractFigureFrames(stdout) {
  const figures = [];
  const visible = [];
  let offset = 0;
  while (offset < stdout.length) {
    const begin = stdout.indexOf(FIGURE_BEGIN, offset);
    if (begin < 0) {
      visible.push(stdout.slice(offset));
      break;
    }
    visible.push(stdout.slice(offset, begin));
    const payloadStart = begin + FIGURE_BEGIN.length;
    const end = stdout.indexOf(FIGURE_END, payloadStart);
    if (end < 0) throw new Error("Figure result end marker is missing");
    const displayList = JSON.parse(stdout.slice(payloadStart, end));
    const nativeHandle = Number(displayList?.figureHandle);
    figures.push({
      handle: Number.isSafeInteger(nativeHandle)
        ? nativeHandle
        : figures.length + 1,
      displayList,
    });
    offset = end + FIGURE_END.length;
  }
  return {
    stdout: visible
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    figures,
  };
}

export function extractUiActions(stdout) {
  const actions = [];
  const visible = [];
  let offset = 0;
  while (offset < stdout.length) {
    const begin = stdout.indexOf(UI_ACTION_BEGIN, offset);
    if (begin < 0) {
      visible.push(stdout.slice(offset));
      break;
    }
    visible.push(stdout.slice(offset, begin));
    const payloadStart = begin + UI_ACTION_BEGIN.length;
    const end = stdout.indexOf(UI_ACTION_END, payloadStart);
    if (end < 0) throw new Error("UI action end marker is missing");
    const action = JSON.parse(stdout.slice(payloadStart, end));
    if (
      action?.type !== "open-examples" &&
      !(
        action?.type === "open-editor" &&
        typeof action.path === "string" &&
        (action.line === undefined || Number.isSafeInteger(action.line))
      )
    ) {
      throw new Error(`Unsupported Nelson UI action: ${String(action?.type)}`);
    }
    actions.push(action);
    offset = end + UI_ACTION_END.length;
  }
  return {
    stdout: visible
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    actions,
  };
}

function longestMarkerPrefixSuffix(text, markers) {
  const maxLength = Math.min(
    text.length,
    Math.max(...markers.map((marker) => marker.length - 1)),
  );
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (markers.some((marker) => marker.startsWith(suffix))) return suffix;
  }
  return "";
}

export function createVisibleOutputFilter(onText) {
  const delimiters = [
    [FIGURE_BEGIN, FIGURE_END],
    [UI_ACTION_BEGIN, UI_ACTION_END],
  ];
  const beginMarkers = delimiters.map(([begin]) => begin);
  let buffer = "";
  let hiddenEnd = "";
  let emitted = false;

  const emit = (text) => {
    if (!text) return;
    emitted = true;
    onText(text);
  };

  const drain = () => {
    while (buffer) {
      if (hiddenEnd) {
        const end = buffer.indexOf(hiddenEnd);
        if (end < 0) {
          buffer = longestMarkerPrefixSuffix(buffer, [hiddenEnd]);
          return;
        }
        buffer = buffer.slice(end + hiddenEnd.length);
        hiddenEnd = "";
        continue;
      }

      let next = null;
      for (const [begin, end] of delimiters) {
        const index = buffer.indexOf(begin);
        if (index >= 0 && (!next || index < next.index)) {
          next = { begin, end, index };
        }
      }
      if (next) {
        emit(buffer.slice(0, next.index));
        buffer = buffer.slice(next.index + next.begin.length);
        hiddenEnd = next.end;
        continue;
      }

      const suffix = longestMarkerPrefixSuffix(buffer, beginMarkers);
      emit(buffer.slice(0, buffer.length - suffix.length));
      buffer = suffix;
      return;
    }
  };

  return {
    push(text) {
      buffer += String(text);
      drain();
    },
    finish() {
      if (!hiddenEnd) emit(buffer);
      buffer = "";
      hiddenEnd = "";
    },
    get emitted() {
      return emitted;
    },
  };
}
