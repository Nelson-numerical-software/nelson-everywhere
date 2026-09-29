% Parse XML text, write a document and read it back.
filename = [tempdir(), 'nelson-example.xml'];
xmlText = '<measurements><value unit="C">21.4</value></measurements>';
xmlwrite(filename, xmlText);
document = xmlread(filename);
disp(xmlwrite(document));
