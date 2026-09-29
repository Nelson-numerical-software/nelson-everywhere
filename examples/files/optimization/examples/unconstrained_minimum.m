% Minimize a smooth two-variable objective without constraints.
objective = @(x)(x(1) - 2) .^ 2 + (x(2) + 3) .^ 2;
[solution, value] = fminsearch(objective, [0; 0], optimset('Display', 'off'));
disp('Minimum location:');
disp(solution);
disp(['Objective value: ', mat2str(value)]);
