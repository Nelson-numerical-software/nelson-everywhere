// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

function checkStatus(status, operation) {
  if (status !== "ok" && status !== "warning")
    throw new Error(`FMU ${operation} failed: ${String(status)}`);
}

const NUMERIC = {
  Float64: [Float64Array, "Float64"],
  Float32: [Float32Array, "Float32"],
  Int8: [Int8Array, "Int8"],
  UInt8: [Uint8Array, "Uint8"],
  Int16: [Int16Array, "Int16"],
  UInt16: [Uint16Array, "Uint16"],
  Int32: [Int32Array, "Int32"],
  UInt32: [Uint32Array, "Uint32"],
  Int64: [BigInt64Array, "Int64"],
  UInt64: [BigUint64Array, "UInt64"],
  Enumeration: [BigInt64Array, "Int64"],
  Boolean: [Array, "Boolean"],
};
const portable = (v) => NUMERIC[v.dataType || "Float64"] !== undefined;
const sizeOf = (v) => v.arraySize ?? 1;
const widths = (state) => ({
  inputs: state.inputs.length,
  outputs: state.outputs.length,
  inputWidths: state.inputs.map(sizeOf),
  outputWidths: state.outputs.map(sizeOf),
});

function selectVariables(variables, names) {
  if (!names.length) return variables;
  return names.map((name) => {
    const variable = variables.find((value) => value.name === name);
    if (!variable) throw new Error(`Unknown FMU variable: ${name}`);
    return variable;
  });
}

function numericGroups(variables) {
  const groups = new Map();
  let offset = 0;
  for (const variable of variables) {
    const type = variable.dataType || "Float64";
    if (!NUMERIC[type]) throw new Error(`Unsupported FMU signal type: ${type}`);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ variable, offset });
    offset += sizeOf(variable);
  }
  return groups;
}

function typedValues(type, values) {
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new Error("Browser FMU values must be finite numbers.");
  const [ArrayType, method] = NUMERIC[type];
  if (method === "Boolean") return values.map(Boolean);
  if (method.endsWith("64") && !method.startsWith("Float")) {
    if (!values.every(Number.isSafeInteger))
      throw new Error("FMU integer exceeds safe numeric precision.");
    return new ArrayType(values.map(BigInt));
  }
  return new ArrayType(values);
}

function setVariables(instance, variables, values) {
  if (values.length !== variables.reduce((n, v) => n + sizeOf(v), 0))
    throw new Error("FMU value count mismatch.");
  for (const [type, entries] of numericGroups(variables)) {
    const refs = new Uint32Array(
      entries.map(({ variable }) => variable.valueReference)
    );
    const data = entries.flatMap(({ variable, offset }) =>
      values.slice(offset, offset + sizeOf(variable))
    );
    checkStatus(
      instance[`set${NUMERIC[type][1]}`](refs, typedValues(type, data)),
      "set variables"
    );
  }
}

function getVariables(instance, variables) {
  const values = [];
  for (const [type, entries] of numericGroups(variables)) {
    const refs = new Uint32Array(
      entries.map(({ variable }) => variable.valueReference)
    );
    const data = Array.from(instance[`get${NUMERIC[type][1]}`](refs), Number);
    let start = 0;
    for (const { variable, offset } of entries) {
      const width = sizeOf(variable);
      if (start + width > data.length)
        throw new Error("FMU output count mismatch.");
      for (let i = 0; i < width; i++) values[offset + i] = data[start + i];
      start += width;
    }
    if (start !== data.length) throw new Error("FMU output count mismatch.");
  }
  if (!values.every(Number.isFinite))
    throw new Error("Browser FMU outputs must be finite numbers.");
  return values;
}

function updateEvents(instance) {
  let changed = false;
  for (let iteration = 0; iteration < 100; iteration++) {
    const info = instance.updateDiscreteStates();
    changed ||= info.valuesOfContinuousStatesChanged;
    if (info.terminateSimulation) return { changed, requestStop: true };
    if (!info.newDiscreteStatesNeeded) return { changed, requestStop: false };
  }
  throw new Error("FMU discrete states did not converge after 100 iterations.");
}

function rawFmiCall(state, method, args) {
  const { instance } = state;
  let value;
  const type = Object.keys(NUMERIC).find(
    (type) =>
      method === `get${NUMERIC[type][1]}` || method === `set${NUMERIC[type][1]}`
  );
  if (type) {
    const refs = new Uint32Array(args[0]);
    value = method.startsWith("get")
      ? instance[method](refs)
      : instance[method](refs, typedValues(type, args[1]));
  } else if (method === "updateDiscreteStates") {
    return updateEvents(instance);
  } else {
    const allowed = [
      "enterInitializationMode",
      "exitInitializationMode",
      "enterConfigurationMode",
      "exitConfigurationMode",
      "enterContinuousTimeMode",
      "enterEventMode",
      "terminate",
      "setTime",
      "setContinuousStates",
      "getContinuousStates",
      "getContinuousStateDerivatives",
      "getEventIndicators",
      "getNumberOfContinuousStates",
      "getNumberOfEventIndicators",
      "completedIntegratorStep",
      "doStep",
    ];
    if (!allowed.includes(method))
      throw new Error(`Unsupported FMI method: ${method}`);
    if (method === "setContinuousStates")
      args = [typedValues("Float64", args[0])];
    value = instance[method](...args);
  }
  if (typeof value === "string") checkStatus(value, method);
  if (method === "exitInitializationMode") state.initialized = true;
  if (method === "terminate") state.initialized = false;
  if (ArrayBuffer.isView(value) || Array.isArray(value))
    return Array.from(value, Number);
  return typeof value === "bigint" ? Number(value) : value;
}

function initialize(state, request) {
  const { instance, model } = state;
  const parameters = selectVariables(
    model.info.variables.filter(
      (v) =>
        portable(v) &&
        ["parameter", "structuralParameter"].includes(v.causality)
    ),
    request.names
  );
  // An empty selection means use the FMU defaults, including its array parameters.
  const selected = request.names.length ? parameters : [];
  const structural = selected.filter(
    (v) => v.causality === "structuralParameter"
  );
  if (structural.length) {
    checkStatus(instance.enterConfigurationMode(), "configuration");
    for (const variable of structural) {
      const value = request.values[request.names.indexOf(variable.name)];
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000000)
        throw new Error("Invalid FMU structural dimension.");
      setVariables(instance, [variable], [value]);
    }
    checkStatus(instance.exitConfigurationMode(), "exit configuration");
    for (const variable of [...state.inputs, ...state.outputs]) {
      if (variable.dimensions)
        variable.arraySize = variable.dimensions.reduce(
          (n, d) =>
            n *
            (structural.some((v) => v.valueReference === d.vr)
              ? request.values[
                  request.names.indexOf(
                    structural.find((v) => v.valueReference === d.vr).name
                  )
                ]
              : d.start),
          1
        );
      if (sizeOf(variable) > 1000000)
        throw new Error("FMU array exceeds 1000000 elements.");
    }
  }
  checkStatus(
    instance.enterInitializationMode(
      request.tolerance,
      request.startTime,
      request.stopTime
    ),
    "initialization"
  );
  for (const variable of selected.filter((v) => v.causality === "parameter"))
    setVariables(
      instance,
      [variable],
      [request.values[request.names.indexOf(variable.name)]]
    );
  checkStatus(instance.exitInitializationMode(), "exit initialization");
  let result = widths(state);
  if (state.kind === "me") {
    result = { ...result, ...updateEvents(instance) };
    checkStatus(instance.enterContinuousTimeMode(), "continuous time mode");
    result.states = Array.from(instance.getContinuousStates());
    result.events = Number(instance.getNumberOfEventIndicators());
  }
  state.initialized = true;
  return result;
}

export class FmuRegistry {
  models = new Map();
  instances = new Map();
  nextId = 1;

  async register(model) {
    if (this.models.has(model.path)) return;
    const url = URL.createObjectURL(
      new Blob([model.source], { type: "text/javascript" })
    );
    try {
      const binding = await import(/* webpackIgnore: true */ url);
      const modules = new Map();
      for (const [name, bytes] of model.files)
        modules.set(name, await WebAssembly.compile(bytes));
      const { wasiImports } = await import(
        /* webpackIgnore: true */ model.wasiUrl
      );
      const imports = {
        ...wasiImports,
        "fmi:fmi3/callbacks": {
          logMessage() {},
          clockUpdate() {},
          lockPreemption() {},
          unlockPreemption() {},
        },
        "fmi:fmi3/intermediate-update-callbacks": {
          intermediateUpdate() {
            return { earlyReturnRequested: false, earlyReturnTime: 0 };
          },
        },
      };
      const component = await binding.instantiate((name) => {
        if (!modules.has(name)) throw new Error(`Missing FMU module: ${name}`);
        return modules.get(name);
      }, imports);
      if (
        !component.coSimulation?.CoSimulationInstance &&
        !component.modelExchange?.ModelExchangeInstance
      )
        throw new Error(
          "FMU does not export an FMI-LS-WASM CS or ME interface."
        );
      this.models.set(model.path, { ...model, component });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  create(request) {
    const model = this.models.get(request.path);
    if (!model)
      throw new Error(
        "WebAssembly FMU is not loaded. Select its .fmu archive first."
      );
    const id = this.nextId++;
    const kind = request.kind || "cs";
    const args = [`nflow-${id}`, model.token, "", false, false];
    const factory =
      kind === "me"
        ? model.component.modelExchange?.ModelExchangeInstance
        : model.component.coSimulation?.CoSimulationInstance;
    if (!factory)
      throw new Error(`FMU does not export the requested ${kind} interface.`);
    const instance =
      kind === "me"
        ? factory.instantiateModelExchange(...args)
        : factory.instantiateCoSimulation(
            ...args,
            false,
            false,
            new Uint32Array()
          );
    if (!instance) throw new Error("FMU instantiation failed.");
    const variables = model.info.variables.filter(portable);
    const state = {
      instance,
      model,
      kind,
      inputs: variables
        .filter((v) => v.causality === "input")
        .map((v) => ({ ...v })),
      outputs: variables
        .filter((v) => v.causality === "output")
        .map((v) => ({ ...v })),
      initialized: false,
    };
    this.instances.set(id, state);
    return { id, ...widths(state) };
  }

  call(request) {
    try {
      if (request.op === "inspect") {
        const model = this.models.get(request.path);
        if (!model)
          throw new Error(
            "WebAssembly FMU is not registered. Select it with Browse FMU first."
          );
        return { ok: true, info: model.info };
      }
      if (request.op === "create") return { ok: true, ...this.create(request) };
      const state = this.instances.get(request.id);
      if (!state) throw new Error("Unknown FMU instance.");
      const { instance } = state;
      let result = {};
      switch (request.op) {
        case "fmi":
          result = { value: rawFmiCall(state, request.method, request.args) };
          break;
        case "configure":
          state.inputs = selectVariables(state.inputs, request.inputs);
          state.outputs = selectVariables(state.outputs, request.outputs);
          result = widths(state);
          break;
        case "initialize":
          result = initialize(state, request);
          break;
        case "inputs":
          setVariables(instance, state.inputs, request.values);
          break;
        case "outputs":
          result = { values: getVariables(instance, state.outputs) };
          break;
        case "step": {
          const step = instance.doStep(request.time, request.stepSize, false);
          if (
            !Number.isFinite(step.lastSuccessfulTime) ||
            step.earlyReturn ||
            step.eventHandlingNeeded
          )
            throw new Error(
              "FMU requires step rescheduling or event mode, which is not supported by this browser adapter."
            );
          result = { requestStop: step.terminateSimulation === true };
          break;
        }
        case "state":
          checkStatus(instance.setTime(request.time), "set time");
          checkStatus(
            instance.setContinuousStates(
              typedValues("Float64", request.values)
            ),
            "set states"
          );
          break;
        case "derivatives":
          result = {
            values: Array.from(instance.getContinuousStateDerivatives()),
          };
          break;
        case "indicators":
          result = { values: Array.from(instance.getEventIndicators()) };
          break;
        case "event":
          checkStatus(instance.enterEventMode(), "event mode");
          result = {
            ...updateEvents(instance),
            values: Array.from(instance.getContinuousStates()),
          };
          checkStatus(
            instance.enterContinuousTimeMode(),
            "continuous time mode"
          );
          break;
        case "destroy":
          try {
            if (state.initialized)
              checkStatus(instance.terminate(), "termination");
          } finally {
            instance[Symbol.dispose || Symbol.for("dispose")]?.();
            this.instances.delete(request.id);
          }
          break;
        default:
          throw new Error(`Unknown FMU operation: ${request.op}`);
      }
      if (result.values && !result.values.every(Number.isFinite))
        throw new Error("Non-finite FMU result.");
      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createFmuRegistry() {
  const registry = new FmuRegistry();
  return {
    register: registry.register.bind(registry),
    call: registry.call.bind(registry),
  };
}
