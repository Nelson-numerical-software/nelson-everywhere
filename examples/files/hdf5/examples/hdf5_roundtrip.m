% Store a numeric dataset in HDF5 and read it back.
filename = [tempdir(), 'nelson-example.h5'];
if isfile(filename), rmfile(filename); end
values = reshape(1:12, 3, 4);
h5create(filename, '/measurements', size(values));
h5write(filename, '/measurements', values);
restored = h5read(filename, '/measurements');
disp(restored);
