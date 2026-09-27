(() => {
  "use strict";
  function stopZoom(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function hasZoomModifier(event) {
    return event.ctrlKey || event.metaKey;
  }
  function isZoomKey(event) {
    const key = event.key.toLowerCase();
    return (
      key === "+" ||
      key === "-" ||
      key === "=" ||
      key === "0" ||
      key === "_" ||
      key === "add" ||
      key === "subtract"
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (hasZoomModifier(event) && isZoomKey(event)) stopZoom(event);
    },
    true
  );
  window.addEventListener(
    "wheel",
    (event) => {
      if (hasZoomModifier(event)) stopZoom(event);
    },
    { capture: true, passive: false }
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) stopZoom(event);
    },
    { capture: true, passive: false }
  );
  window.addEventListener("gesturestart", stopZoom, {
    capture: true,
    passive: false,
  });
  window.addEventListener("gesturechange", stopZoom, {
    capture: true,
    passive: false,
  });

  const ui = {
    en_US: {
      title: "Examples",
      all: "All examples",
      builtIn: "Nelson",
      external: "External toolboxes",
      open: "Open in editor",
      run: "Run",
      running: "Running…",
      found: "examples",
      empty: "No examples match this search.",
      diagnostics: "Catalog diagnostics",
    },
    fr_FR: {
      title: "Exemples",
      all: "Tous les exemples",
      builtIn: "Nelson",
      external: "Toolboxes externes",
      open: "Ouvrir dans l’éditeur",
      run: "Exécuter",
      running: "Exécution…",
      found: "exemples",
      empty: "Aucun exemple ne correspond à cette recherche.",
      diagnostics: "Diagnostics du catalogue",
    },
  };
  let catalog = { groups: [], diagnostics: [], locale: "en_US" };
  let activeModule = "all";
  let rpcId = 0;
  const examplesChannelName =
    new URLSearchParams(window.location.search).get("channel") ||
    "nelson-examples";

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function transportReady() {
    if (typeof window.webui?.call === "function") {
      return (
        typeof window.webui.isConnected !== "function" ||
        window.webui.isConnected()
      );
    }
    if (typeof BroadcastChannel === "function") return true;
    return typeof window.examplesRpc === "function";
  }

  async function waitForTransport() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (transportReady()) return;
      await delay(100);
    }
    throw new Error("Native bridge unavailable");
  }

  async function callTransport(payload) {
    if (typeof window.webui?.call === "function") {
      return window.webui.call("examplesRpc", payload);
    }
    if (typeof BroadcastChannel === "function") {
      const request =
        typeof payload === "string" ? JSON.parse(payload) : payload;
      return new Promise((resolve, reject) => {
        const channel = new BroadcastChannel(examplesChannelName);
        const timeoutMilliseconds = request.method === "run" ? 120000 : 10000;
        const timer = window.setTimeout(() => {
          channel.close();
          reject(new Error("Browser examples bridge unavailable"));
        }, timeoutMilliseconds);
        channel.onmessage = (event) => {
          if (event.data?.type !== "response" || event.data?.id !== request.id)
            return;
          window.clearTimeout(timer);
          channel.close();
          resolve(event.data.payload);
        };
        channel.postMessage({ type: "request", payload: request });
      });
    }
    return window.examplesRpc(payload);
  }

  async function rpc(method, params = {}) {
    await waitForTransport();
    const raw = await callTransport(
      JSON.stringify({ id: ++rpcId, method, params })
    );
    const response = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (response.error)
      throw new Error(response.error.message || "Request failed");
    return response.result;
  }

  function language() {
    return ui[catalog.locale] || ui.en_US;
  }
  function allExamples() {
    return catalog.groups.flatMap((group) => group.examples);
  }
  function matches(example, group, query) {
    if (activeModule !== "all" && group.name !== activeModule) return false;
    const text = [
      example.title,
      example.description,
      group.title,
      ...example.tags,
      ...example.requirements,
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(query);
  }
  function element(name, className, text) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function toast(message) {
    const node = document.getElementById("toast");
    node.textContent = message;
    node.classList.add("visible");
    window.setTimeout(() => node.classList.remove("visible"), 2400);
  }
  async function action(method, path) {
    try {
      await rpc(method, { path });
    } catch (error) {
      toast(error.message);
    }
  }
  async function commandAction(command) {
    try {
      await rpc("run", { command });
    } catch (error) {
      toast(error.message);
    }
  }
  async function runExample(button, launch, title) {
    // The interpreter runs the example asynchronously and gives no completion
    // signal back, so surface an immediate "running" state on the button to
    // acknowledge the click and cover the gap before the figure appears.
    if (button.dataset.running === "1") return;
    button.dataset.running = "1";
    button.dataset.idleLabel = button.textContent;
    button.classList.add("running");
    button.textContent = language().running;
    toast(`${title} — ${language().running}`);
    const started = Date.now();
    try {
      await launch();
    } finally {
      const elapsed = Date.now() - started;
      const minimumVisible = 1400;
      if (elapsed < minimumVisible) await delay(minimumVisible - elapsed);
      button.dataset.running = "";
      button.classList.remove("running");
      if (button.dataset.idleLabel)
        button.textContent = button.dataset.idleLabel;
    }
  }
  function card(example) {
    const t = language();
    const node = element("article", "card example-gallery-card");
    node.append(
      element("h3", "", example.title),
      element("p", "description", example.description)
    );
    const badges = element("div", "badges");
    example.tags.forEach((tag) =>
      badges.append(element("span", "badge example-gallery-badge", tag))
    );
    example.requirements.forEach((req) =>
      badges.append(
        element("span", "badge example-gallery-badge requirement", req)
      )
    );
    const actions = element("div", "actions example-gallery-actions");
    const run = element("button", "primary", t.run);
    if (example.command) {
      // A command entry runs a builtin call; there is no file to open in the editor.
      run.addEventListener("click", () =>
        runExample(run, () => commandAction(example.command), example.title)
      );
      actions.append(run);
    } else {
      const open = element("button", "", t.open);
      open.addEventListener("click", () => action("open", example.file));
      run.addEventListener("click", () =>
        runExample(run, () => action("run", example.file), example.title)
      );
      actions.append(open, run);
    }
    node.append(badges, actions);
    return node;
  }
  function selectModule(name) {
    activeModule = name;
    render();
    document.querySelector("main").scrollIntoView({ block: "start" });
  }
  function renderRail() {
    const rail = document.getElementById("rail");
    rail.replaceChildren();
    ["nelson", "external"].forEach((source) => {
      const groups = catalog.groups.filter((group) => group.source === source);
      if (!groups.length) return;
      rail.append(
        element(
          "div",
          "rail-heading",
          source === "nelson" ? language().builtIn : language().external
        )
      );
      groups.forEach((group) => {
        const button = element(
          "button",
          `rail-item example-gallery-category${
            activeModule === group.name ? " active" : ""
          }`
        );
        button.type = "button";
        button.dataset.module = group.name;
        button.append(
          element("span", "", group.title),
          element("strong", "", String(group.examples.length))
        );
        button.addEventListener("click", () => selectModule(group.name));
        rail.append(button);
      });
    });
    document
      .querySelector('[data-module="all"]')
      .classList.toggle("active", activeModule === "all");
  }
  function renderDiagnostics() {
    const node = document.getElementById("diagnostics");
    node.replaceChildren();
    node.hidden = !catalog.diagnostics.length;
    if (!catalog.diagnostics.length) return;
    node.append(element("strong", "", language().diagnostics));
    catalog.diagnostics.forEach((item) =>
      node.append(element("p", "", `${item.module}: ${item.message}`))
    );
  }
  function render() {
    const t = language();
    const query = document.getElementById("search").value.trim().toLowerCase();
    const content = document.getElementById("content");
    content.replaceChildren();
    let shown = 0;
    catalog.groups.forEach((group) => {
      const examples = group.examples.filter((example) =>
        matches(example, group, query)
      );
      if (!examples.length) return;
      shown += examples.length;
      const section = element("section", "group");
      const header = element("div", "group-header");
      header.append(
        element("h2", "", group.title),
        element("span", "group-count", String(examples.length))
      );
      const cards = element("div", "cards");
      examples.forEach((example) => cards.append(card(example)));
      section.append(header, cards);
      content.append(section);
    });
    document.documentElement.lang = catalog.locale.replace("_", "-");
    document.getElementById("page-title").textContent = t.title;
    document.getElementById("all-label").textContent = t.all;
    document.getElementById("all-count").textContent = String(
      allExamples().length
    );
    document.getElementById("summary").textContent = `${shown} ${t.found}`;
    document.getElementById("empty").textContent = t.empty;
    document.getElementById("empty").hidden = shown !== 0;
    renderRail();
    renderDiagnostics();
  }
  async function load(method = "list") {
    try {
      catalog = await rpc(method);
      if (
        activeModule !== "all" &&
        !catalog.groups.some((group) => group.name === activeModule)
      )
        activeModule = "all";
      render();
    } catch (error) {
      catalog = {
        groups: [],
        diagnostics: [{ module: "webview", message: error.message }],
        locale: "en_US",
      };
      render();
      toast(error.message);
    }
  }
  window.reloadExamples = () => load("list");
  document.getElementById("search").addEventListener("input", render);
  document
    .getElementById("refresh")
    .addEventListener("click", () => load("refresh"));
  document
    .querySelector('[data-module="all"]')
    .addEventListener("click", () => selectModule("all"));
  load();
})();
