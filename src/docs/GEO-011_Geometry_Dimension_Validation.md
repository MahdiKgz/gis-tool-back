# GEO-011 Geometry Dimension Validation

## Scope

GEO-011 validates coordinate-position arity and values in every supported
GeoJSON geometry type, including nested geometry collections.

## Rules

- Every position contains at least two ordinates.
- Every ordinate is a finite number.
- All positions within one geometry use the same dimension.
- Separate children of a `GeometryCollection` may use different dimensions.

SnapGIS accepts consistent 2D, 3D, 4D, and higher-dimensional positions.
The validator does not discard optional Z/M data or force a dataset-wide
dimension.

Each issue reports the feature, geometry-collection path, coordinate path,
expected dimension, and actual dimension. Geometry coordinate structure and
multipart topology remain GEO-012 concerns.

## Policy and pipeline

Dimensions and invalid ordinates are not guessed or padded. Affected features
are preserved, recommended for manual review, and quarantined before ring,
line, polygon, or topology processing.

Worker results expose:

- `invalidGeometryDimensionsFound`
- `invalidCoordinateValuesFound`
- `geometryDimensionIssuesUnresolved`
- `geometryDimensionValidationReport`

## Test data

`src/test-data/geojson/geo-011-geometry-dimensions.geojson` covers valid 3D,
one-dimensional, mixed-dimension, and non-numeric positions. Unit tests also
cover 2D/4D input and independent geometry-collection child dimensions.
