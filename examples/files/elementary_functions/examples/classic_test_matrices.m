% Construct classic matrices used in numerical experiments.
matrixOrder = 5;
hilbertMatrix = hilb(matrixOrder);
inverseHilbertMatrix = invhilb(matrixOrder);
hilbertInverseError = norm(hilbertMatrix * inverseHilbertMatrix - eye(matrixOrder), 1);
pascalMatrix = pascal(matrixOrder);
magicMatrix = magic(matrixOrder);
magicRowSums = sum(magicMatrix, 2);

disp('Hilbert inverse residual:');
disp(hilbertInverseError);
disp('Pascal matrix:');
disp(pascalMatrix);
disp('Magic-square row sums:');
disp(magicRowSums);
