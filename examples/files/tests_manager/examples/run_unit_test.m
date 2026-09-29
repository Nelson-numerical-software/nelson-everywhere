% Create and execute a small unit test in the temporary directory.
filename = [tempdir(), 'test_nelson_example.m'];
filewrite(filename, 'asserts.isequal(sum(1:4), 10);');
status = test_run(filename);
if status ~= 1
  error('The generated unit test failed.');
end
disp(['Test status: ', int2str(status)]);
