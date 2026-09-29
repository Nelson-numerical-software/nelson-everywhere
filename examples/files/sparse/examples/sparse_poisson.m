% Assemble a sparse one-dimensional Poisson operator and solve it.
n = 40;
e = ones(n, 1);
A = spdiags([-e, 2 * e, -e], [-1, 0, 1], n, n);
b = ones(n, 1);
x = A \ b;
disp(['Nonzeros: ', int2str(nnz(A)), ', residual: ', mat2str(norm(A * x - b))]);
