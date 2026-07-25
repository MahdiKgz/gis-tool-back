# GEO-004 Ring Orientation Validation

## Scope

The ring-orientation stage validates and normalizes winding for exterior and
interior rings in `Polygon`, `MultiPolygon`, and nested
`GeometryCollection` geometries.

SnapGIS follows the RFC 7946 right-hand rule:

- Exterior rings are counterclockwise.
- Interior rings are clockwise.

Orientation uses the first two ordinates while reversal preserves each
position in full, including optional Z or M values.

## Detection

The detector evaluates only finite, structurally valid, closed rings. Open or
corrupted rings are handled by GEO-002 and GEO-003 first.

Signed area is calculated relative to the first position and accumulated with
Kahan compensated summation. Translating coordinates to a local origin
reduces cancellation for large projected coordinates and narrow rings without
introducing a coordinate-unit-specific tolerance.

Rings with exactly zero or non-finite signed area have indeterminate
orientation. They are reported for manual review and are never reversed.

## Normalization policy

Incorrect but determinate winding is a high-confidence, non-destructive
repair. SnapGIS reverses only the ring coordinate array, preserving closure,
coordinate values, properties, and the input object.

The repair boundary recalculates orientation before changing a ring. Stale,
already-correct, or indeterminate targets remain unchanged and are not counted
as normalized.

## Pipeline integration

Orientation validation runs after ring closure and duplicate-vertex repair.
Features with unresolved indeterminate orientation are preserved in output and
quarantined from topology stages.

Topology and Mapshaper can create or rewrite rings, so the same idempotent
normalization module runs before Mapshaper and again on Mapshaper output. This
ensures both hole preservation during processing and compliant winding in the
emitted GeoJSON.

Worker results expose:

- `ringOrientationIssuesFound`
- `inputRingsOrientationNormalized`
- `ringOrientationIssuesUnresolved`
- `postProcessingRingsOrientationNormalized`
- `postProcessingRingOrientationIssuesUnresolved`
- `ringsOrientationNormalized`
- `ringOrientationValidationReport`

## Test data

The integration dataset is:

`src/test-data/geojson/geo-004-ring-orientation.geojson`

It covers incorrect exterior and interior rings, `MultiPolygon` winding,
nested geometry collections, already-correct controls, and an indeterminate
collinear ring.
