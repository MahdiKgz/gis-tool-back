# GEO-010 Geometry Type Validation

## Scope

GEO-010 validates GeoJSON geometry type declarations before specialized
processing begins.

Supported RFC 7946 geometry types are:

- `Point`
- `MultiPoint`
- `LineString`
- `MultiLineString`
- `Polygon`
- `MultiPolygon`
- `GeometryCollection`

A feature-level `null` geometry is valid under RFC 7946 and is preserved.

## Detection

The validator reports:

- malformed feature-array entries;
- non-object geometry values;
- missing or non-string `type` members;
- unsupported geometry type names; and
- `GeometryCollection` objects without a `geometries` array.

Geometry collections are traversed recursively, and every issue records its
exact nested path. Coordinate shape and dimensional consistency remain the
responsibility of GEO-011 and GEO-012.

The root must be a `FeatureCollection` with a feature array containing feature
objects. Invalid roots or malformed feature entries fail the worker early with
a descriptive GEO-010 error because the remaining pipeline requires
feature-collection semantics.

## Policy and pipeline

Type declarations are never guessed or rewritten. Invalid feature geometries
are preserved, reported for manual review, and quarantined before ring,
polygon, line, or topology processors run.

Worker results expose:

- `invalidGeometryTypesFound`
- `geometryTypeIssuesUnresolved`
- `geometryTypeValidationReport`

## Test data

`src/test-data/geojson/geo-010-geometry-types.geojson` covers a valid point,
an unsupported type, a missing type, an unsupported nested collection child,
and a valid null geometry. Unit tests cover every supported geometry type,
invalid objects, invalid collection containers, nested paths, and invalid
roots.
