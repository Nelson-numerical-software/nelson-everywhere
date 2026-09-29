% Map identifiers to values and retrieve selected entries.
codes = ["FR", "DE", "ES"];
capitals = ["Paris", "Berlin", "Madrid"];
capitalByCode = dictionary(codes, capitals);
disp("Capital for DE: " + capitalByCode("DE"));
