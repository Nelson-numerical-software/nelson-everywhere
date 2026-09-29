% Capture model coefficients in a function handle.
decayRate = 0.75;
offset = 2;
decayModel = @(time) offset + exp(-decayRate * time);
sampleTimes = 0:0.5:3;
modelValues = arrayfun(decayModel, sampleTimes);

disp('Parameterized model values:');
disp(modelValues);
