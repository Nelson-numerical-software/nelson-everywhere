% Export a generated plot to a temporary PNG image.
t = linspace(0, 2 * pi, 200);
figureHandle = figure('Visible', 'off');
plot(t, sin(t), 'LineWidth', 1.5);
title('Sine wave');
filename = [tempdir(), 'nelson-sine.png'];
saveas(figureHandle, filename);
close(figureHandle);
disp(['Image written to: ', filename]);
