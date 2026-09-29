% Create, transform and summarize values in the current workspace.
temperatures = [18.4, 19.1, 21.3, 22.0, 20.7];
celsiusMean = mean(temperatures);
fahrenheitMean = 1.8 * celsiusMean + 32;
disp(['Mean temperature: ', mat2str(celsiusMean), ' C / ', mat2str(fahrenheitMean), ' F']);
