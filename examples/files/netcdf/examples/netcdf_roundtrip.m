% Store a short time series in NetCDF and read it back.
filename = [tempdir(), 'nelson-example.nc'];
if isfile(filename), rmfile(filename); end
nccreate(filename, 'temperature', 'Dimensions', {'time', 5});
ncwrite(filename, 'temperature', [18.1; 19.4; 20.0; 19.7; 18.9]);
restored = ncread(filename, 'temperature');
disp(restored);
