% Minimize a quadratic objective under bounds and a linear inequality.
H = 2 * eye(2);
f = [-2; -4];
A = [1, 1];
b = 2;
[solution, value] = quadprog(H, f, A, b, [], [], [0; 0], []);
disp('Constrained solution:');
disp(solution);
disp(['Objective value: ', mat2str(value)]);
