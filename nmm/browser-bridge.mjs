// Copyright (c) 2026-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

const CHANNEL_NAME = "nelson-nmm";
const PREFS_KEY = "nelson-nmm-gui-preferences";
const REGISTRY_KEY = "nelson-nmm-registry-url";
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MUTATING_METHODS = new Set([
  "install",
  "installSource",
  "load",
  "pin",
  "remove",
  "setRegistry",
  "unload",
  "unpin",
  "update",
]);

function response(id, result) {
  return JSON.stringify({ id, result });
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function localeCandidates(language) {
  const normalized = String(language || "en-US").replace("-", "_");
  const languageOnly = normalized.split("_")[0];
  return [...new Set([normalized, languageOnly, "en_US"])];
}

export class NmmBrowserBridge {
  #channel;
  #fetch;
  #storage;
  #location;
  #navigator;
  #open;
  #nextToken = 1;
  #pending = new Map();

  constructor(options = {}) {
    const Channel = options.BroadcastChannel ?? globalThis.BroadcastChannel;
    if (typeof Channel !== "function") {
      throw new Error("Package Manager requires BroadcastChannel support");
    }
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.#storage = options.storage ?? globalThis.localStorage;
    this.#location = options.location ?? globalThis.location;
    this.#navigator = options.navigator ?? globalThis.navigator;
    this.#open = options.open ?? globalThis.open?.bind(globalThis);
    const requestedChannel = new URL(this.#location.href).searchParams.get(
      "channel",
    );
    const channelName =
      requestedChannel &&
      /^nelson-nmm-[A-Za-z0-9._-]{1,128}$/.test(requestedChannel)
        ? requestedChannel
        : CHANNEL_NAME;
    this.#channel = new Channel(channelName);
    this.#channel.onmessage = (event) => this.#receive(event.data);
  }

  close() {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Package Manager bridge closed"));
    }
    this.#pending.clear();
    this.#channel.close();
  }

  async call(payload) {
    const request = JSON.parse(String(payload));
    const id = Number(request.id ?? 0);
    try {
      const local = await this.#local(
        request.method,
        safeObject(request.params),
      );
      if (local.handled) return response(id, local.result);
      request.params = {
        ...safeObject(request.params),
        browserRegistryUrl: this.#storage?.getItem(REGISTRY_KEY) ?? "",
      };
      const result = await this.#remote(request);
      if (request.method === "setRegistry" && !result?.error) {
        const url = String(request.params.url ?? "").trim();
        if (url) this.#storage?.setItem(REGISTRY_KEY, url);
        else this.#storage?.removeItem(REGISTRY_KEY);
      }
      if (MUTATING_METHODS.has(String(request.method))) {
        globalThis.window?.nmmGuiPush?.("changed", "");
      }
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async #local(method, params) {
    if (method === "i18n")
      return { handled: true, result: await this.#translations() };
    if (method === "prefs") {
      const stored = this.#storage?.getItem(PREFS_KEY);
      return {
        handled: true,
        result: stored ? safeObject(JSON.parse(stored)) : {},
      };
    }
    if (method === "savePrefs") {
      const stored = this.#storage?.getItem(PREFS_KEY);
      const current = stored ? safeObject(JSON.parse(stored)) : {};
      const merged = { ...current, ...safeObject(params.prefs) };
      this.#storage?.setItem(PREFS_KEY, JSON.stringify(merged));
      return { handled: true, result: merged };
    }
    if (method === "pendingDeepLink") return { handled: true, result: {} };
    if (method === "doc" && !String(params.path ?? "")) {
      return { handled: true, result: await this.#repositoryDocument(params) };
    }
    if (method === "openExternal") {
      const url = String(params.url ?? "");
      if (!/^https?:\/\//i.test(url)) throw new Error("Invalid external URL");
      this.#open?.(url, "_blank", "noopener");
      return { handled: true, result: { opened: true } };
    }
    return { handled: false };
  }

  async #repositoryDocument(params) {
    const base = rawRepositoryBase(params.repository);
    if (!base || typeof this.#fetch !== "function") {
      return { ok: true, text: "" };
    }
    const candidates =
      String(params.kind).toLowerCase() === "changelog"
        ? ["CHANGELOG.md", "changelog.md"]
        : ["README.md", "readme.md"];
    for (const name of candidates) {
      try {
        const response = await this.#fetch(new URL(name, base));
        if (!response.ok) continue;
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES) {
          throw new Error("Package document exceeds the browser size limit");
        }
        return { ok: true, text };
      } catch {
        // Try the alternate conventional filename. Documentation is optional.
      }
    }
    return { ok: true, text: "" };
  }

  async #translations() {
    let english = "{}";
    const base = new URL("./locale/", this.#location.href);
    const englishResponse = await this.#fetch(
      new URL("nmm-ui-en_US.json", base),
    );
    if (englishResponse.ok) english = await englishResponse.text();
    for (const locale of localeCandidates(this.#navigator?.language)) {
      const localized = await this.#fetch(
        new URL(`nmm-ui-${locale}.json`, base),
      );
      if (!localized.ok) continue;
      return {
        ok: true,
        locale,
        en_US: english,
        strings: await localized.text(),
      };
    }
    return { ok: true, locale: "en_US", en_US: english, strings: english };
  }

  #remote(request) {
    const token = this.#nextToken++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(token, { resolve, reject });
    });
    this.#channel.postMessage({ type: "request", token, payload: request });
    return promise;
  }

  #receive(message) {
    if (message?.type !== "response" || !Number.isSafeInteger(message.token))
      return;
    const pending = this.#pending.get(message.token);
    if (!pending) return;
    this.#pending.delete(message.token);
    pending.resolve(message.payload);
  }
}

function rawRepositoryBase(repository) {
  const url = String(repository ?? "")
    .trim()
    .replace(/(?:\.git)?\/?$/, "");
  let match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (match) {
    return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/HEAD/`;
  }
  match = url.match(/^https:\/\/gitlab\.com\/(.+)$/i);
  if (match) return `https://gitlab.com/${match[1]}/-/raw/HEAD/`;
  return "";
}

if (typeof window !== "undefined") {
  const bridge = new NmmBrowserBridge();
  window.nmmGuiRpc = (payload) => bridge.call(payload);
  window.addEventListener("pagehide", () => bridge.close(), { once: true });
}
