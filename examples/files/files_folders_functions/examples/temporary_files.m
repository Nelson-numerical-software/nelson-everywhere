% Create, inspect and remove a text file in the temporary directory.
folder = [tempdir(), 'nelson-files-example/'];
if ~isdir(folder)
  mkdir(folder);
end
filename = [folder, 'measurements.txt'];
filewrite(filename, ['12.4', newline(), '13.1', newline()]);
disp(fileread(filename));
rmfile(filename);
rmdir(folder);
