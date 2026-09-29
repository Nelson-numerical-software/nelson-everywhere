% Count observations by category and display a summary table.
observations = table({'north'; 'south'; 'north'; 'east'; 'south'; 'north'}, ...
  [12; 8; 15; 11; 10; 16], 'VariableNames', {'Region', 'Value'});
summary = groupcounts(observations, 'Region');
disp(summary);
