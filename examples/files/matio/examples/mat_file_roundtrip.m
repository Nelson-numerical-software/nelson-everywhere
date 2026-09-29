% Save selected variables in a temporary MAT file and reload them.
filename = [tempdir(), 'nelson-example.mat'];
labels = {'north', 'south'};
values = [12.3, 15.8];
save(filename, 'labels', 'values');
clear labels values;
load(filename);
disp(table(labels', values', 'VariableNames', {'Region', 'Value'}));
