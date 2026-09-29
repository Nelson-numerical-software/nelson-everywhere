% Fill missing samples and compute a moving average.
measurements = [18; NaN; 21; 25; NaN; 24];
[cleaned, replaced] = fillmissing(measurements, 'linear');
smoothed = movmean(cleaned, 3);
disp(table(measurements, cleaned, replaced, smoothed));
