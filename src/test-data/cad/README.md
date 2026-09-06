# Synthetic CAD fixtures

These fixtures are generated for this repository and contain no third-party map data.

- `projected-parcel.dwgadd` is the reproducible LibreDWG input for `projected-parcel.dwg` (R2000). Build with `.cad-runtime/bin/dwgadd -o output.dwg projected-parcel.dwgadd`. It has one closed polygon with a duplicate vertex.
- `projected-parcel.dgn` is a DGN-v7 file generated with GDAL/pyogrio from a Polygon ring: `(500000,3900000), (500000,3900100), (500100,3900100), (500100,3900000), (500000,3900000)`.

Both use EPSG:32639. The first vertex must reproject near longitude 51, latitude 35.24. The parcel is approximately 100 m square. DGN-v8 binary conversion is not covered by these fixtures.
