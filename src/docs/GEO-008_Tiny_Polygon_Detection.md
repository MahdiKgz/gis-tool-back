# GEO-008 Tiny Polygon Detection

## Scope

GEO-008 identifies strictly positive-area polygon components below a
configurable square-metre threshold in `Polygon`, `MultiPolygon`, and nested
`GeometryCollection` geometries.

Exact zero is excluded and remains GEO-007's responsibility. Components
whose area equals the threshold are also excluded, making the boundary
deterministic.

## Policy and configuration

`tinyPolygonAreaM2` must be finite and non-negative. It defaults to `0.01`;
zero disables tiny-polygon findings.

Size alone is not sufficient evidence that a polygon should be deleted.
GEO-008 therefore reports findings for manual review, preserves input
geometry, and quarantines affected features from destructive downstream
topology operations.

The worker uses the same tolerance-derived threshold as sliver and tiny-hole
classification:

`tinyPolygonAreaM2 = (toleranceMeters * 10)²`

Worker results expose:

- `tinyPolygonsFound`
- `tinyPolygonIssuesUnresolved`
- `tinyPolygonValidationReport`
- `appliedTinyPolygonAreaM2`

## Test data

`src/test-data/geojson/geo-008-tiny-polygons.geojson` covers a tiny
positive-area polygon, an exact-zero control, and a normal-area control.
