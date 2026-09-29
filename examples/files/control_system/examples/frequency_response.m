% Plot the frequency response of a low-pass transfer function.
system = tf(25, [1, 4, 25]);
figure();
bode(system);
title('Low-pass frequency response');
