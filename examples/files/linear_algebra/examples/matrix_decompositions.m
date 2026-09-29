% Compare LU, QR and eigenvalue decompositions of one matrix.
A = [4, 2, 1; 2, 5, 2; 1, 2, 3];
[L, U, P] = lu(A);
[Q, R] = qr(A);
[V, D] = eig(A);
disp(['LU error: ', mat2str(norm(P * A - L * U))]);
disp(['QR error: ', mat2str(norm(A - Q * R))]);
disp('Eigenvalues:');
disp(diag(D));
