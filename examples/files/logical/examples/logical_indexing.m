% Select valid in-range measurements with a logical mask.
measurements = [12.4 NaN -3.1 18.7 42.0 9.5];
validMask = isfinite(measurements) & measurements >= 0 & measurements <= 20;
validMeasurements = measurements(validMask);
cleanMeasurements = measurements;
cleanMeasurements(~validMask) = 0;

disp('Valid measurements:');
disp(validMeasurements);
disp('Cleaned measurements:');
disp(cleanMeasurements);
