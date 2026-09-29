% Organize heterogeneous records with structures and cell arrays.
record(1) = struct('Name', 'sensor-a', 'Samples', [2.1, 2.4, 2.2]);
record(2) = struct('Name', 'sensor-b', 'Samples', [3.0, 2.9, 3.2]);
for k = 1:length(record)
  disp([record(k).Name, ': ', mat2str(mean(record(k).Samples))]);
end
