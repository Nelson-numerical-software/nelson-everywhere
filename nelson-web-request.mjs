// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// webread / websave / webwrite for the WebAssembly engine.
//
// The engine blocks on the request like libcurl does natively. Inside the
// dedicated engine Worker a synchronous XMLHttpRequest is allowed (it is only
// forbidden on a page's main thread), so no asynchronous machinery is needed on
// the C++ side. See modules/webtools/src/cpp/WebRESTWasm.cpp for the contract.

// Header names the browser refuses to let a script set; they are skipped
// silently instead of failing the whole request.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);

function failure(kind, error) {
  return { status: 0, body: null, kind, error: String(error) };
}

function exceptionKind(exception) {
  const name = String(exception?.name ?? "");
  if (name === "TimeoutError") return "timeout";
  return "network";
}

/**
 * Performs one blocking HTTP request.
 *
 * @param {object} spec `{ url, method, headers: [[name, value]], timeoutMs,
 *   username, password, body? }` as serialized by the engine.
 * @param {object} [environment] `XMLHttpRequest` and `btoa` overrides (tests).
 * @returns {{ status: number, body: Uint8Array | null, kind: string | null,
 *   error: string | null }} `kind` is `unavailable`, `timeout` or `network`
 *   when the request could not complete; otherwise `status` is the HTTP
 *   status and `body` the raw response bytes.
 */
export function performSyncWebRequest(spec, environment = {}) {
  const XHR = environment.XMLHttpRequest ?? globalThis.XMLHttpRequest;
  const encodeBase64 = environment.btoa ?? globalThis.btoa;
  if (typeof XHR !== "function") {
    return failure(
      "unavailable",
      "Web access is unavailable in this runtime (no browser network stack)"
    );
  }
  const request = new XHR();
  try {
    request.open(String(spec.method || "GET"), String(spec.url), false);
  } catch (exception) {
    return failure("network", exception?.message ?? exception);
  }
  request.responseType = "arraybuffer";
  const timeoutMs = Number(spec.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) request.timeout = timeoutMs;
  for (const header of Array.isArray(spec.headers) ? spec.headers : []) {
    if (!Array.isArray(header) || header.length !== 2) continue;
    const [name, value] = header;
    if (FORBIDDEN_REQUEST_HEADERS.has(String(name).toLowerCase())) continue;
    try {
      request.setRequestHeader(String(name), String(value));
    } catch {
      // An invalid header name or value: ignore it like libcurl would.
    }
  }
  if (spec.username && typeof encodeBase64 === "function") {
    const credentials = `${spec.username}:${spec.password ?? ""}`;
    request.setRequestHeader(
      "Authorization",
      `Basic ${encodeBase64(unescape(encodeURIComponent(credentials)))}`
    );
  }
  try {
    request.send(typeof spec.body === "string" ? spec.body : null);
  } catch (exception) {
    return failure(exceptionKind(exception), exception?.message ?? exception);
  }
  const response = request.response;
  const body =
    response instanceof ArrayBuffer
      ? new Uint8Array(response)
      : typeof response === "string"
      ? new TextEncoder().encode(response)
      : new Uint8Array(0);
  const contentType = request.getResponseHeader("Content-Type") || "";
  return { status: Number(request.status) | 0, body, contentType, kind: null, error: null };
}
