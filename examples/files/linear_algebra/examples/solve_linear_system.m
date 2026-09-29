% Solve an electrical-network style linear system and report the residual.
A = [10, -2, 0; -2, 8, -1; 0, -1, 5];
b = [12; 15; 7];
x = A \ b;
disp('Solution:');
disp(x);
disp(['Residual norm: ', mat2str(norm(A * x - b))]);
