// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

function checkStatus(status, operation) {
  if (status !== "ok" && status !== "warning") {
    throw new Error(`FMU ${operation} failed: ${String(status)}`);
  }
}

function selectVariables(variables, names) {
  if (!names.length) return variables;
  return names.map((name) => {
    const variable = variables.find((value) => value.name === name);
    if (!variable) throw new Error(`Unknown FMU variable: ${name}`);
    return variable;
  });
}

export class FmuRegistry {
  models = new Map();
  instances = new Map();
  nextId = 1;

  async register(model) {
    if (this.models.has(model.path)) return;
    const source = new Blob([model.source], { type: "text/javascript" });
    const url = URL.createObjectURL(source);
    try {
      const binding = await import(/* webpackIgnore: true */ url);
      const files = new Map(model.files);
      const modules = new Map();
      for (const [name, bytes] of files)
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
      if (!component.coSimulation?.CoSimulationInstance)
        throw new Error(
          "FMU does not export the FMI-LS-WASM Co-Simulation interface."
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
    const instance =
      model.component.coSimulation.CoSimulationInstance.instantiateCoSimulation(
        `nflow-${id}`,
        model.token,
        "",
        false,
        false,
        false,
        false,
        new Uint32Array()
      );
    if (!instance) throw new Error("FMU instantiation failed.");
    const variables = model.info.variables;
    const inputs = variables.filter((value) => value.causality === "input");
    const outputs = variables.filter((value) => value.causality === "output");
    this.instances.set(id, {
      instance,
      model,
      inputs,
      outputs,
      initialized: false,
    });
    return { id, inputs: inputs.length, outputs: outputs.length };
  }

  call(request) {
    try {
      if (request.op === "create") return { ok: true, ...this.create(request) };
      const state = this.instances.get(request.id);
      if (!state) throw new Error("Unknown FMU instance.");
      const { instance, model } = state;
      let result = {};
      switch (request.op) {
        case "configure":
          state.inputs = selectVariables(state.inputs, request.inputs);
          state.outputs = selectVariables(state.outputs, request.outputs);
          result = {
            inputs: state.inputs.length,
            outputs: state.outputs.length,
          };
          break;
        case "initialize": {
          checkStatus(
            instance.enterInitializationMode(
              request.tolerance,
              request.startTime,
              request.stopTime
            ),
            "initialization"
          );
          const parameters = selectVariables(
            model.info.variables.filter(
              (value) => value.causality === "parameter"
            ),
            request.names
          );
          if (request.names.length)
            checkStatus(
              instance.setFloat64(
                new Uint32Array(parameters.map((p) => p.valueReference)),
                new Float64Array(request.values)
              ),
              "parameters"
            );
          checkStatus(instance.exitInitializationMode(), "exit initialization");
          state.initialized = true;
          break;
        }
        case "inputs":
          if (request.values.length !== state.inputs.length)
            throw new Error("FMU input count mismatch.");
          if (
            !request.values.every(
              (value) => typeof value === "number" && Number.isFinite(value)
            )
          )
            throw new Error(
              "Browser FMU inputs must be finite Float64 values."
            );
          if (state.inputs.length)
            checkStatus(
              instance.setFloat64(
                new Uint32Array(state.inputs.map((p) => p.valueReference)),
                new Float64Array(request.values)
              ),
              "inputs"
            );
          break;
        case "outputs":
          result = {
            values: Array.from(
              instance.getFloat64(
                new Uint32Array(state.outputs.map((p) => p.valueReference))
              )
            ),
          };
          if (!result.values.every(Number.isFinite))
            throw new Error(
              "Browser FMU outputs must be finite Float64 values."
            );
          break;
        case "step": {
          const step = instance.doStep(request.time, request.stepSize, false);
          if (
            !Number.isFinite(step.lastSuccessfulTime) ||
            step.earlyReturn ||
            step.eventHandlingNeeded ||
            Math.abs(
              step.lastSuccessfulTime - request.time - request.stepSize
            ) >
              1e-9 * Math.max(1, Math.abs(request.time))
          )
            throw new Error(
              "FMU requires step rescheduling or event mode, which is not supported by this browser adapter."
            );
          result = { requestStop: step.terminateSimulation === true };
          break;
        }
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
