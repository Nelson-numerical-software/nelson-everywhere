% Create and extract a ZIP archive entirely in the temporary directory.
sourceFolder = [tempdir(), 'nelson-archive-source/'];
outputFolder = [tempdir(), 'nelson-archive-output/'];
archive = [tempdir(), 'nelson-example.zip'];
if ~isdir(sourceFolder), mkdir(sourceFolder); end
if ~isdir(outputFolder), mkdir(outputFolder); end
filewrite([sourceFolder, 'notes.txt'], 'A small archived document.');
zip(archive, [sourceFolder, '*.txt']);
files = unzip(archive, outputFolder);
disp(files);
