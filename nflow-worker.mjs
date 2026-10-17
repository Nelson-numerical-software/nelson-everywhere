// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

export async function simulateNFlow(
  evaluate,
  extractMarkedResult,
  diagramJson
) {
  const begin = "__NFLOW_RESULT_BEGIN__";
  const end = "__NFLOW_RESULT_END__";
  const escaped = diagramJson.replace(/'/g, "''");
  const result = await evaluate(
    [
      `nelsonWasmNflowDocument = NFlow.internal.prepareModelJson('${escaped}');`,
      "nelsonWasmNflowResult = __nflow_simulate__(nelsonWasmNflowDocument);",
      `disp(['${begin}', nelsonWasmNflowResult, '${end}']);`,
      "clear nelsonWasmNflowDocument nelsonWasmNflowResult;",
    ].join(" ")
  );
  return JSON.parse(extractMarkedResult(result.stdout, begin, end, "NFlow"));
}
