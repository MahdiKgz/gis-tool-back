# GEO-007 Zero-Area Polygon Detection

## Scope

GEO-007 detects polygon components whose geodesic area is exactly zero in
`Polygon`, `MultiPolygon`, and nested `GeometryCollection` geometries.
Structurally invalid and open rings remain owned by GEO-002 and GEO-003.

## Detection and policy

Each valid polygon component is measured once with Turf's spherical area
calculation. Exact zero is intentionally distinct from a small positive area:
GEO-007 reports degeneracy, while GEO-008 owns configurable tiny-polygon
classification.

Every finding includes its feature identifier, geometry-collection path,
multipart component path, and measured area.

Zero-area geometry cannot be reconstructed reliably without source-domain
knowledge. This stage is report-only: affected features are preserved in
output, marked for manual review, and quarantined from downstream topology
operations.

Worker results expose:

- `zeroAreaPolygonsFound`
- `zeroAreaPolygonIssuesUnresolved`
- `zeroAreaPolygonValidationReport`

## Test data

`src/test-data/geojson/geo-007-zero-area-polygons.geojson` covers a collinear
polygon, a valid control, and a zero-area component within a `MultiPolygon`.
Unit tests additionally cover nested geometry-collection paths.
