% Construct a polynomial from known roots and evaluate it.
expectedRoots = [-2, 1, 3];
coefficients = poly(expectedRoots);
computedRoots = sort(roots(coefficients));
disp('Polynomial coefficients:');
disp(coefficients);
disp('Recovered roots:');
disp(computedRoots);
