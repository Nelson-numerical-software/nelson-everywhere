% Smooth a noisy synthetic signal with a finite impulse response filter.
rng(7);
t = 0:0.01:2;
clean = sin(2 * pi * 3 * t);
noisy = clean + 0.35 * randn(size(t));
b = fir1(20, 0.12);
filtered = filter(b, 1, noisy);
figure();
plot(t, noisy, ':', t, filtered, 'LineWidth', 1.4);
legend('Noisy', 'Filtered');
