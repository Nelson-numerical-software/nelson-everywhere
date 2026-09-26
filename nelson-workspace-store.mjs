// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

const DATABASE_NAME = "nelson-webassembly-workspace";
const DATABASE_VERSION = 1;
const FILE_STORE = "files";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionFinished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

async function openDatabase(factory) {
  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(FILE_STORE)) {
      database.createObjectStore(FILE_STORE, { keyPath: "path" });
    }
  };
  return requestResult(request);
}

class DisabledWorkspaceStore {
  available = false;

  async load() {
    return new Map();
  }

  async replace() {}

  async clear() {}
}

export class IndexedDbWorkspaceStore {
  available = true;
  #database;

  constructor(factory) {
    this.#database = openDatabase(factory);
  }

  async load() {
    const database = await this.#database;
    const transaction = database.transaction(FILE_STORE, "readonly");
    const records = await requestResult(
      transaction.objectStore(FILE_STORE).getAll(),
    );
    await transactionFinished(transaction);
    return new Map(
      records.map(({ path, data }) => [
        String(path),
        data instanceof Uint8Array ? data : new Uint8Array(data),
      ]),
    );
  }

  async replace(files) {
    const database = await this.#database;
    const transaction = database.transaction(FILE_STORE, "readwrite");
    const finished = transactionFinished(transaction);
    const store = transaction.objectStore(FILE_STORE);
    store.clear();
    for (const [path, data] of files) {
      const bytes = new Uint8Array(data);
      store.put({ path, data: bytes.slice().buffer });
    }
    await finished;
  }

  async clear() {
    const database = await this.#database;
    const transaction = database.transaction(FILE_STORE, "readwrite");
    const finished = transactionFinished(transaction);
    transaction.objectStore(FILE_STORE).clear();
    await finished;
  }
}

export function createWorkspaceStore(factory = globalThis.indexedDB) {
  if (!factory || typeof factory.open !== "function") {
    return new DisabledWorkspaceStore();
  }
  return new IndexedDbWorkspaceStore(factory);
}
