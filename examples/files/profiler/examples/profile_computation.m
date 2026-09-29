% Profile a repeatable matrix computation and inspect the collected report.
profile('clear');
profile('on');
for k = 1:25
  singularValues = svd(hilb(30));
end
profile('off');
report = profile('info');
disp(report);
profile('clear');
