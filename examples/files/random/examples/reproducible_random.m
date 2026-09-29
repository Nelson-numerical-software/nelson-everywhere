% Generate reproducible pseudo-random samples.
rng(42);
uniformSamples = rand(1, 5);
normalSamples = randn(1, 5);
disp('Uniform samples:');
disp(uniformSamples);
disp('Normal samples:');
disp(normalSamples);
