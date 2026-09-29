% Join measurements with station metadata using a shared key.
measurements = table([101; 102; 103], [18.2; 21.5; 19.8], ...
  'VariableNames', {'Station', 'Temperature'});
metadata = table([101; 102; 104], {'North'; 'Center'; 'South'}, ...
  'VariableNames', {'Station', 'Area'});
combined = outerjoin(measurements, metadata, 'Keys', 'Station', 'MergeKeys', true);
disp(combined);
