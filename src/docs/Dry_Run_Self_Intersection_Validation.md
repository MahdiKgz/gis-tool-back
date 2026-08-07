# Dry-Run Self-Intersection Validation

## Scope

The dry-run pipeline reports self-intersections in closed, structurally valid
Polygon and MultiPolygon exterior rings, including polygons nested in
GeometryCollection geometries. Detection is report-only and never changes
input coordinates. Self-intersecting interior rings remain owned by the more
specific invalid-hole validator, avoiding duplicate findings for one defect.

The check runs after structural ring validation and before orientation, hole,
spike, zero-area, and tiny-polygon checks. This ordering makes
`SELF_INTERSECTION` the primary diagnosis while preserving useful secondary
consequences such as `ZERO_AREA_POLYGON` or
`INDETERMINATE_RING_ORIENTATION`.

## Detection semantics

Each non-zero-length ring segment is indexed in RBush. Only segments with
overlapping bounding boxes are compared, avoiding an unconditional quadratic
scan. Adjacent segments, including segments made adjacent after ignoring a
consecutive duplicate coordinate, are excluded.

The detector reports three intersection kinds:

- `Crossing`: two non-adjacent segment interiors cross;
- `Touching`: non-adjacent segments meet at one endpoint or point;
- `Overlapping`: non-adjacent collinear segments share a positive-length
  interval.

Each issue includes both segment coordinate paths, both source segments, and
an `intersectionGeometry` Point or LineString. Calculations use the geometry's
XY ordinates; higher coordinate dimensions remain present on the reported
source segments.

## Repair safety

Every self-intersection issue has `repairable: false` and recommends manual
review. The existing worker healing behavior is unchanged. Automatically
unkinking a polygon can split it or change its semantics, so dry-run does not
advertise an automatic repair.

## Controlled fixture baseline

Before integration, `snapgis_topology_test_suite.geojson` at 30 mm produced:

- 12 checks;
- 29 issues;
- no self-intersection finding;
- Feature 8 classified only as zero-area with indeterminate orientation.

After integration it produces:

- 13 checks;
- 30 issues;
- exactly one `SELF_INTERSECTION`, for Feature 8;
- intersection point `[51.465, 35.705]` between ring segments 0 and 2;
- the prior zero-area and orientation findings preserved as secondary issues.

Feature 7's consecutive duplicate vertex remains only a duplicate-vertex
finding and is not misclassified as a self-intersection.

## Known limitations

- Detection uses JavaScript double-precision XY arithmetic.
- Intersections between an exterior and interior ring remain the responsibility
  of invalid-hole validation.
- Intersections between different MultiPolygon components remain the
  responsibility of multipart-integrity validation.
- Dry-run does not yet attach a top-level dedicated finding-geometry field;
  `intersectionGeometry` is available in issue details under the current API
  contract.
