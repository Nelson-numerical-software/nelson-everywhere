% Portable plotting demo shared by native and WebAssembly builds.
x = linspace(0, 2 * pi, 160);
figure;
plot(x, sin(x));

figure;
surf(peaks(49));
