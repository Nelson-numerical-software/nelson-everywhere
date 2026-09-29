% Read, inspect and rewrite structured JSON data without relying on the current directory.
source = [modulepath('json'), '/examples/patient.json'];
patient = jsondecode(fileread(source));
disp(['Patient identifier: ', patient.id]);
output = [tempdir(), 'nelson-patient.json'];
filewrite(output, jsonprettyprint(jsonencode(patient)));
disp(['Formatted copy: ', output]);
