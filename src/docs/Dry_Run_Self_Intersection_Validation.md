# Dry-Run Self-Intersection Validation

## Scope

The dry-run pipeline reports self-intersections in closed, structurally valid
Polygon and MultiPolygon exterior rings, including polygons nested in
GeometryCollection geometries. Dry-run detection never changes input
coordinates, but it now advertises automatic repair for a narrowly defined
isolated-crossing strategy. Self-intersecting interior rings remain owned by
the more specific invalid-hole validator, avoiding duplicate findings for one
defect.

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

An issue is `AutoRepairAvailable` only when all of these conditions hold:

- the feature has exactly one self-intersection and it is a proper `Crossing`;
- the affected geometry is a top-level Polygon or MultiPolygon component;
- the affected component has one exterior ring, no holes, no repeated
  non-closure vertices, and only two-dimensional positions; and
- polygonization produces exactly two simple faces while preserving every
  source vertex.

Healing replaces the affected Polygon (or MultiPolygon component) with those
two faces in one MultiPolygon feature. Feature id and properties are retained.
The complete result must pass self-intersection and multipart-integrity checks;
otherwise the original feature is returned unchanged with a repair failure
reason. Touches, collinear overlaps, multiple crossings, holes, higher
dimensions, and GeometryCollection ownership remain manual review.

Dry-run performs the same polygonization and validation against an immutable
candidate. A crossing is advertised as `AutoRepairAvailable` only when that
feasibility attempt succeeds; no repaired coordinates are returned or stored.

This repair runs before ring-orientation validation in the worker. Bow-ties
have indeterminate signed area, so the previous order quarantined them before
the old generic unkink step could run.

## Controlled fixture baseline

The current `snapgis_topology_test_suite.geojson` dry run at 30 mm produces 18
checks, 41 detailed issues, and 14 issue groups. It reports exactly one
`SELF_INTERSECTION`, for Feature 8, at `[51.465, 35.705]` between ring segments
0 and 2. That issue is `AutoRepairAvailable`; the input's zero-area and
indeterminate-orientation consequences remain visible as separate manual
findings because dry-run does not mutate or stage intermediate repairs.

During healing, the isolated crossing is repaired before those secondary
checks evaluate the working geometry.

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
