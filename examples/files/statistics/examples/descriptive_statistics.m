% Summarize a small measurement series with robust statistics.
measurements = [10.2, 9.8, 10.5, 10.1, 15.4, 9.9, 10.0];
disp(['Mean: ', mat2str(mean(measurements))]);
disp(['Median: ', mat2str(median(measurements))]);
disp(['Standard deviation: ', mat2str(std(measurements))]);
disp(['Interquartile range: ', mat2str(iqr(measurements))]);
