//=============================================================================
// Copyright (c) 2016-present Allan CORNET (Nelson)
//=============================================================================
// This file is part of Nelson.
//=============================================================================
// LICENCE_BLOCK_BEGIN
// SPDX-License-Identifier: LGPL-3.0-or-later
// LICENCE_BLOCK_END
//=============================================================================
// Stand-alone gallery window opened by demo() on the desktop: the shared
// component over the WebUI `examplesRpc` binding (list, refresh, open, run).
//=============================================================================
import { mountExampleGallery } from './example-gallery.js';

function stopZoom(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}
function hasZoomModifier(event) {
  return event.ctrlKey || event.metaKey;
}
function isZoomKey(event) {
  const key = event.key.toLowerCase();
  return ['+', '-', '=', '0', '_', 'add', 'subtract'].includes(key);
}
window.addEventListener('keydown', (event) => { if (hasZoomModifier(event) && isZoomKey(event)) stopZoom(event); }, true);
window.addEventListener('wheel', (event) => { if (hasZoomModifier(event)) stopZoom(event); }, { capture: true, passive: false });
window.addEventListener('touchmove', (event) => { if (event.touches.length > 1) stopZoom(event); }, { capture: true, passive: false });
window.addEventListener('gesturestart', stopZoom, { capture: true, passive: false });
window.addEventListener('gesturechange', stopZoom, { capture: true, passive: false });

let rpcId = 0;
// The WebAssembly desktop opens this page in a separate tab and answers the
// gallery through a BroadcastChannel named in the URL instead of a native bridge.
const examplesChannelName = new URLSearchParams(window.location.search).get('channel') || 'nelson-examples';

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function transportReady() {
  if (typeof window.webui?.call === 'function') {
    return typeof window.webui.isConnected !== 'function' || window.webui.isConnected();
  }
  if (typeof BroadcastChannel === 'function') return true;
  return typeof window.examplesRpc === 'function';
}

async function waitForTransport() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (transportReady()) return;
    await delay(100);
  }
  throw new Error('Native bridge unavailable');
}

async function callTransport(payload) {
  if (typeof window.webui?.call === 'function') {
    return window.webui.call('examplesRpc', payload);
  }
  if (typeof BroadcastChannel === 'function') {
    const request = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return new Promise((resolve, reject) => {
      const channel = new BroadcastChannel(examplesChannelName);
      const timeoutMilliseconds = request.method === 'run' ? 120000 : 10000;
      const timer = window.setTimeout(() => {
        channel.close();
        reject(new Error('Browser examples bridge unavailable'));
      }, timeoutMilliseconds);
      channel.onmessage = (event) => {
        if (event.data?.type !== 'response' || event.data?.id !== request.id) return;
        window.clearTimeout(timer);
        channel.close();
        resolve(event.data.payload);
      };
      channel.postMessage({ type: 'request', payload: request });
    });
  }
  return window.examplesRpc(payload);
}

async function rpc(method, params = {}) {
  await waitForTransport();
  const raw = await callTransport(JSON.stringify({ id: ++rpcId, method, params }));
  const response = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (response.error) throw new Error(response.error.message || 'Request failed');
  return response.result;
}

// The interpreter validates every path and command against its own catalog,
// so the page never builds a command line itself.
function action(method, entry) {
  return entry.kind === 'command' ? rpc(method, { command: entry.command }) : rpc(method, { path: entry.file });
}

const gallery = mountExampleGallery(document.getElementById('gallery'), {
  primarySource: 'nelson',
  hasEditor: true,
  compact: 'auto',
  load: ({ refresh }) => rpc(refresh ? 'refresh' : 'list'),
  onRun: (entry) => action('run', entry),
  onOpen: (entry) => action('open', entry),
});

window.reloadExamples = () => gallery.reload(false);
