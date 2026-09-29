% Encode labels as categorical data and count each category.
labels = categorical({'low'; 'high'; 'medium'; 'low'; 'high'; 'low'});
disp('Categories:');
disp(categories(labels));
disp('Counts:');
disp(countcats(labels));
