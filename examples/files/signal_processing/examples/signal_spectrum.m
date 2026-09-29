% Identify the dominant frequencies in a synthetic sampled signal.
sampleRate = 200;
t = (0:399) / sampleRate;
signal = sin(2 * pi * 12 * t) + 0.45 * sin(2 * pi * 35 * t);
spectrum = abs(fft(signal));
frequency = (0:length(signal) - 1) * sampleRate / length(signal);
figure();
plot(frequency(1:200), spectrum(1:200));
xlabel('Frequency (Hz)');
ylabel('Magnitude');
