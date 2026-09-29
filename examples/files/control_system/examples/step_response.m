% Plot the time response of a stable second-order transfer function.
system = tf(1, [1, 0.8, 1]);
figure();
step(system);
title('Second-order step response');
