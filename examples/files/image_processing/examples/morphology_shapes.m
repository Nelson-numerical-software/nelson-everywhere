% Clean and outline binary shapes with morphology.
binaryImage = false(100, 140);
binaryImage(20:75, 25:60) = true;
binaryImage(35:85, 80:120) = true;
binaryImage(10, 10) = true;
cleaned = bwmorph(binaryImage, 'clean');
outline = bwperim(cleaned);
figure();
imshow(outline);
title('Detected shape boundaries');
