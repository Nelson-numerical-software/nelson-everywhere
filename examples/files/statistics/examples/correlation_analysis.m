% Measure correlation between two related observations.
hours = [1; 2; 3; 4; 5; 6];
scores = [52; 57; 63; 68; 74; 81];
R = corrcoef(hours, scores);
disp(['Correlation coefficient: ', mat2str(R(1, 2))]);
