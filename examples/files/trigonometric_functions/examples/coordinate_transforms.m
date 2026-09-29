% Convert points between Cartesian, polar and spherical coordinates.
angles = deg2rad([0 30 90 180]);
radii = [1 2 3 4];
[cartesianX, cartesianY] = pol2cart(angles, radii);
[recoveredAngles, recoveredRadii] = cart2pol(cartesianX, cartesianY);
polarRoundTripError = max(abs(recoveredRadii - radii));

azimuth = deg2rad(35);
elevation = deg2rad(20);
radius = 3;
[spatialX, spatialY, spatialZ] = sph2cart(azimuth, elevation, radius);
[recoveredAzimuth, recoveredElevation, recoveredRadius] = ...
  cart2sph(spatialX, spatialY, spatialZ);
sphericalRoundTripError = max(abs([recoveredAzimuth - azimuth, ...
  recoveredElevation - elevation, recoveredRadius - radius]));

disp(['Polar round-trip error: ', num2str(polarRoundTripError)]);
disp(['Spherical round-trip error: ', num2str(sphericalRoundTripError)]);
