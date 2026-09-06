# Shapefile regression fixtures

These small synthetic fixtures were generated for this repository; no external data is included.

- `duplicate-wgs84.shp`: one clockwise WGS84 polygon with a consecutive duplicate vertex, around 51E / 35N. Bare SHP intentionally has no attribute table or projection sidecar.
- `projected-parcel.zip`: SHP, SHX, DBF and PRJ for one 100 m square in EPSG:32639, with one duplicate vertex and `name=utm-parcel`. The first vertex is 500000 m east, 0 m north and must convert to 51E / 0N.

Tests assert reprojection, attribute preservation, dry-run findings and compatibility with the duplicate-vertex repair processor used by the healing worker. They do not exercise the full queued healing lifecycle.
