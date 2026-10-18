// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Relay broker for the shared WebAssembly engine.
//
// One SharedWorker per origin owns a broker. Every page (desktop, NFlow editor,
// satellite windows) connects a MessagePort to it. The engine itself is NOT
// hosted here: SharedWorkers are not cross-origin isolated in current
// browsers, so the SharedArrayBuffer mailboxes the engine relies on could not
// cross their ports. Instead one connected page, the owner, runs the engine in
// its own dedicated Worker (keeping its mailboxes) and the broker relays the
// other pages' requests to that owner and the owner's events back to them.
// When the owner page goes away the broker elects the oldest remaining page
// as the next owner; that page starts a fresh engine and the others rejoin it.

const PROTOCOL_VERSION = 1;

export const BROKER_REQUEST_TYPES = Object.freeze([
  "broker.hello",
  "broker.claim",
  "broker.disconnect",
]);

export const RELAY_EVENTS = Object.freeze({
  request: "relay.request",
  reply: "relay.reply",
  broadcast: "relay.broadcast",
  peers: "relay.peers",
  owner: "relay.owner",
  engineLost: "engine.lost",
});

function transferablesOf(message) {
  const list = [];
  const visit = (value, depth) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (value instanceof ArrayBuffer) {
      list.push(value);
      return;
    }
    if (ArrayBuffer.isView(value)) return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      visit(item, depth + 1);
    }
  };
  visit(message, 0);
  return list;
}

export function createEngineBroker() {
  // Insertion order gives the election order (oldest page first).
  const ports = new Map(); // port -> { key }
  let nextKey = 1;
  let owner = null; // port
  let ownerModuleUrl = null;

  function post(port, message, transfer) {
    try {
      if (transfer && transfer.length > 0) port.postMessage(message, transfer);
      else port.postMessage(message);
      return true;
    } catch {
      forget(port);
      return false;
    }
  }

  function reply(port, id, ok, value) {
    post(port, {
      version: PROTOCOL_VERSION,
      id,
      ok,
      ...(ok ? { result: value } : { error: String(value) }),
    });
  }

  function clientPorts() {
    return [...ports.keys()].filter((port) => port !== owner);
  }

  function publishPeers() {
    if (!owner) return;
    post(owner, {
      version: PROTOCOL_VERSION,
      event: RELAY_EVENTS.peers,
      peers: clientPorts().length,
    });
  }

  function portByKey(key) {
    for (const [port, entry] of ports) if (entry.key === key) return port;
    return null;
  }

  function electOwner() {
    const [next] = clientPorts();
    for (const port of ports.keys()) {
      post(port, {
        version: PROTOCOL_VERSION,
        event: RELAY_EVENTS.engineLost,
        elected: port === next,
        moduleUrl: ownerModuleUrl,
      });
    }
  }

  function forget(port) {
    if (!ports.has(port)) return;
    ports.delete(port);
    if (owner === port) {
      owner = null;
      electOwner();
      return;
    }
    publishPeers();
  }

  function helloResult() {
    return {
      shared: true,
      relay: true,
      hasOwner: owner !== null,
      moduleUrl: ownerModuleUrl,
      clients: ports.size,
    };
  }

  function handleClaim(port, request) {
    if (owner !== null && owner !== port) {
      reply(port, request.id, true, {
        claimed: false,
        moduleUrl: ownerModuleUrl,
      });
      return;
    }
    owner = port;
    ownerModuleUrl = String(request.moduleUrl ?? "");
    reply(port, request.id, true, { claimed: true, peers: clientPorts().length });
    for (const client of clientPorts()) {
      post(client, {
        version: PROTOCOL_VERSION,
        event: RELAY_EVENTS.owner,
        moduleUrl: ownerModuleUrl,
      });
    }
    publishPeers();
  }

  function forwardToOwner(port, request) {
    if (!owner) {
      reply(port, request.id, false, "The shared Nelson engine has no owner");
      return;
    }
    const message = {
      version: PROTOCOL_VERSION,
      event: RELAY_EVENTS.request,
      client: ports.get(port).key,
      request,
    };
    post(owner, message, transferablesOf(message));
  }

  function onOwnerEvent(port, message) {
    if (port !== owner) return;
    if (message.event === RELAY_EVENTS.reply) {
      const target = portByKey(message.client);
      if (target) post(target, message.message, transferablesOf(message.message));
      return;
    }
    if (message.event === RELAY_EVENTS.broadcast) {
      for (const client of clientPorts()) post(client, message.message);
    }
  }

  function onPortMessage(port, message) {
    if (!message || message.version !== PROTOCOL_VERSION) return;
    if (typeof message.event === "string") {
      onOwnerEvent(port, message);
      return;
    }
    if (!Number.isInteger(message.id)) return;
    switch (message.type) {
      case "broker.hello":
        reply(port, message.id, true, helloResult());
        return;
      case "broker.claim":
        handleClaim(port, message);
        return;
      case "broker.disconnect":
        forget(port);
        return;
      default:
        forwardToOwner(port, message);
    }
  }

  return {
    connect(port) {
      ports.set(port, { key: nextKey++ });
      port.addEventListener("message", (event) =>
        onPortMessage(port, event.data)
      );
      // Browsers that implement MessagePort "close" let the broker notice a
      // page that vanished without sending broker.disconnect.
      port.addEventListener("close", () => forget(port));
      if (typeof port.start === "function") port.start();
      publishPeers();
    },
    disconnect(port) {
      forget(port);
    },
    get hasOwner() {
      return owner !== null;
    },
    get clientCount() {
      return ports.size;
    },
  };
}
