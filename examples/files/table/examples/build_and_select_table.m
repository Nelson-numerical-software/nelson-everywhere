% Build a table and select rows using a logical condition.
city = {'Paris'; 'Lyon'; 'Lille'; 'Nice'};
temperature = [21.2; 24.8; 19.7; 26.1];
rain = [false; false; true; false];
weather = table(city, temperature, rain, 'VariableNames', {'City', 'Temperature', 'Rain'});
warmAndDry = weather(weather.Temperature > 22 & ~weather.Rain, :);
disp(warmAndDry);
