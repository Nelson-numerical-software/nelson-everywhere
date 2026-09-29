% Parse a compact set of comma-separated measurement records.
records = ["temperature,21.5,C"; "pressure,101.3,kPa"; "humidity,48.0,%"];
fields = split(records, ',');
measurementNames = fields(:, 1);
measurementValues = str2double(fields(:, 2));
measurementUnits = fields(:, 3);
summaryLines = compose('%s: %.1f %s', measurementNames, measurementValues, measurementUnits);
disp(summaryLines);
