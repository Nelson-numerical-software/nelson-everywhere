% Demonstrate bounded conversion and saturating integer arithmetic.
rawSamples = [-20 0 42 260];
byteSamples = uint8(rawSamples);
brightenedSamples = byteSamples + uint8(40);
signedRange = [intmin('int16'), intmax('int16')];

disp('Converted bytes:');
disp(byteSamples);
disp('Brightened bytes:');
disp(brightenedSamples);
disp('Signed 16-bit range:');
disp(signedRange);
