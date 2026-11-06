// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Help-viewer serving for the Nelson WebAssembly cross-origin-isolation service
// worker. Loaded with importScripts() into nelson-coi-serviceworker.js (a classic
// worker) and also CommonJS-exported so the pure helpers can be unit-tested.
//
// The built-in help ships as same-origin `.nlpack` bundles (one per module and
// language) listed in `runtime-resources/index.json`. Each bundle wraps a single
// `.nhz` ZIP. This module serves the self-contained help viewer at same-origin
// `/help/<lang>/<path>` URLs by fetching the owning module's bundle on demand,
// unwrapping the NLRPACK1 container, unzipping the `.nhz` with fflate, and caching
// the extracted files — so the engine's virtual filesystem (which a service worker
// cannot read) is never needed, and only the modules the user actually opens are
// downloaded.

(function (root) {
  'use strict';

  // --- pure helpers (unit-testable; no fetch/caches/fflate) ---

  // Unwrap an NLRPACK1 container and return the bytes of its single member.
  // Layout: 8-byte magic "NLRPACK1", 4-byte little-endian header length, a JSON
  // header { files: [{ file, offset, bytes }] }, then the concatenated payloads.
  function nlrpackSinglePayload(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let magic = '';
    for (let i = 0; i < 8; i += 1) magic += String.fromCharCode(bytes[i]);
    if (magic !== 'NLRPACK1') throw new Error('not an NLRPACK1 bundle');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = dv.getUint32(8, true);
    const headerStart = 12;
    const headerText = new TextDecoder().decode(
      bytes.subarray(headerStart, headerStart + headerLength)
    );
    const header = JSON.parse(headerText);
    const entry = header && Array.isArray(header.files) ? header.files[0] : null;
    if (!entry) throw new Error('empty NLRPACK1 bundle');
    const payloadBase = headerStart + headerLength;
    const start = payloadBase + (entry.offset || 0);
    return bytes.subarray(start, start + entry.bytes);
  }

  // Build { "<module>/<lang>": "<bundle path>" } from a runtime-resources index.
  const ARCHIVE_RE = /modules\.([A-Za-z0-9_]+)\.help\.([A-Za-z_]+)\.nhz(?:\.nlpack)?$/;
  function buildHelpBundleMap(index) {
    const map = {};
    const modules = (index && index.modules) || [];
    const helpTools = modules.find(function (m) {
      return m && m.module === 'help_tools';
    });
    const archives =
      helpTools && helpTools.bundles && helpTools.bundles.archives
        ? helpTools.bundles.archives
        : [];
    for (let i = 0; i < archives.length; i += 1) {
      const file = archives[i] && archives[i].file;
      if (!file) continue;
      const matched = ARCHIVE_RE.exec(file);
      if (!matched) continue;
      map[matched[1] + '/' + matched[2]] = file;
    }
    return map;
  }

  // The module that owns a lang-relative path. A first segment that names a known
  // module (e.g. "graphics/surf.html") belongs to that module; everything else
  // (viewer shell, search index, shared assets) comes from the "main" bundle.
  function moduleForPath(rest, knownModules) {
    const slash = rest.indexOf('/');
    if (slash !== -1) {
      const head = rest.slice(0, slash);
      if (knownModules && knownModules.has(head)) return head;
    }
    return 'main';
  }

  // Lang-relative target for an extracted archive entry: strip the "main/" prefix
  // (main's files live at the language root); keep "<module>/..." as-is.
  function targetForEntry(entryName) {
    return entryName.indexOf('main/') === 0 ? entryName.slice(5) : entryName;
  }

  const CONTENT_TYPES = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    css: 'text/css; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    map: 'application/json; charset=utf-8',
  };
  function helpContentType(path) {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return CONTENT_TYPES[ext] || 'application/octet-stream';
  }

  // --- runtime serving (needs self/fetch/caches/fflate) ---

  // Injected by the host service worker: { scope, build, withIsolationHeaders }.
  let config = null;
  function initHelpRoute(options) {
    config = options;
  }

  const HELP_ROUTE_RE = /^help\/([A-Za-z_][A-Za-z0-9_]*)\/(.*)$/;

  // Return { lang, rest } for a same-origin help request, or null when the path is
  // not under the help route. `rest` has its query/hash stripped.
  function matchHelpRequest(pathname) {
    if (!config) return null;
    const scopePath = new URL(config.scope).pathname;
    if (pathname.indexOf(scopePath) !== 0) return null;
    const relative = pathname.slice(scopePath.length);
    const matched = HELP_ROUTE_RE.exec(relative);
    if (!matched) return null;
    return { lang: matched[1], rest: matched[2] || 'index.html' };
  }

  let bundleMapPromise = null;
  function helpBundleMap() {
    if (!bundleMapPromise) {
      const indexUrl = new URL('runtime-resources/index.json', config.scope).toString();
      bundleMapPromise = fetch(indexUrl)
        .then(function (response) {
          if (!response.ok) throw new Error('runtime-resources index HTTP ' + response.status);
          return response.json();
        })
        .then(function (index) {
          const map = buildHelpBundleMap(index);
          const modules = new Set(
            Object.keys(map).map(function (key) {
              return key.slice(0, key.indexOf('/'));
            })
          );
          return { map: map, modules: modules };
        })
        .catch(function (error) {
          bundleMapPromise = null;
          throw error;
        });
    }
    return bundleMapPromise;
  }

  const extracting = new Map();
  async function extractBundle(cache, lang, moduleKey, bundleRelative) {
    const already = extracting.get(moduleKey + '/' + lang);
    if (already) return already;
    const job = (async function () {
      const bundleUrl = new URL(bundleRelative, config.scope).toString();
      const response = await fetch(bundleUrl);
      if (!response.ok) throw new Error('help bundle HTTP ' + response.status);
      const nhz = nlrpackSinglePayload(new Uint8Array(await response.arrayBuffer()));
      const files = self.fflate.unzipSync(nhz);
      const puts = [];
      for (const entryName in files) {
        if (!Object.prototype.hasOwnProperty.call(files, entryName)) continue;
        if (entryName.charAt(entryName.length - 1) === '/') continue;
        const target = targetForEntry(entryName);
        const key = new URL('help/' + lang + '/' + target, config.scope).toString();
        const headers = new Headers({ 'Content-Type': helpContentType(target) });
        const body = files[entryName];
        puts.push(cache.put(key, config.withIsolationHeaders(new Response(body, { headers }))));
      }
      await Promise.all(puts);
    })();
    extracting.set(moduleKey + '/' + lang, job);
    try {
      await job;
    } catch (error) {
      extracting.delete(moduleKey + '/' + lang);
      throw error;
    }
    return job;
  }

  async function serveHelp(request) {
    const match = matchHelpRequest(new URL(request.url).pathname);
    const cache = await caches.open('nelson-help-' + config.build);
    const cacheKey = new URL('help/' + match.lang + '/' + match.rest, config.scope).toString();

    let hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const { map, modules } = await helpBundleMap();
      const owner = moduleForPath(match.rest, modules);
      const ownerBundle = map[owner + '/' + match.lang];
      if (ownerBundle) {
        await extractBundle(cache, match.lang, owner, ownerBundle);
        hit = await cache.match(cacheKey);
        if (hit) return hit;
      }
      // Shared assets referenced from a module page live in `main`; fall back to it.
      if (owner !== 'main' && map['main/' + match.lang]) {
        await extractBundle(cache, match.lang, 'main', map['main/' + match.lang]);
        hit = await cache.match(cacheKey);
        if (hit) return hit;
      }
    } catch (error) {
      return config.withIsolationHeaders(
        new Response('Help unavailable: ' + (error && error.message ? error.message : error), {
          status: 502,
          headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
        })
      );
    }

    return config.withIsolationHeaders(
      new Response('Not found', {
        status: 404,
        headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
      })
    );
  }

  const api = {
    nlrpackSinglePayload: nlrpackSinglePayload,
    buildHelpBundleMap: buildHelpBundleMap,
    moduleForPath: moduleForPath,
    targetForEntry: targetForEntry,
    helpContentType: helpContentType,
    ARCHIVE_RE: ARCHIVE_RE,
    initHelpRoute: initHelpRoute,
    matchHelpRequest: matchHelpRequest,
    serveHelp: serveHelp,
  };

  root.NelsonHelpSW = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
