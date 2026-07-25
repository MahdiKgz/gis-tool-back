# GEO-001 Duplicate Vertex Detection

## Scope

The duplicate-vertex stage validates coordinate sequences in `LineString`,
`MultiLineString`, `Polygon`, `MultiPolygon`, and nested
`GeometryCollection` geometries. It runs immediately after input parsing and
before topology-specific polygon and line processing.

## Detection

Detection is linear in the number of vertices. Each coordinate sequence uses
a map keyed by the complete position, including optional Z or M ordinates.
The validator distinguishes:

- **Consecutive duplicates**: adjacent positions with identical ordinates.
- **Non-consecutive duplicates**: a repeated position elsewhere in the same
  sequence.

The final position that closes a valid GeoJSON polygon ring is required and
is not reported as a duplicate. Additional repeated closing positions are
reported.

## Repair policy

Only consecutive duplicates are eligible for automatic repair. A repair is
performed only when the complete sequence remains structurally valid:

- A line retains at least two positions.
- A ring retains at least four positions, stays closed, and contains at least
  three distinct non-closing vertices.

Non-consecutive repeats and duplicates whose removal would collapse a
sequence are retained and reported for manual review. Input objects are not
mutated; only features containing repaired sequences are reconstructed.

## Validation report

Worker results expose:

- `duplicateVerticesFound`
- `duplicateVerticesRemoved`
- `duplicateVerticesUnresolved`
- `duplicateVertexValidationReport`

Each issue identifies the feature, geometry collection path, coordinate path,
original duplicate path, duplicate kind, repair eligibility, final status,
and recommended action.

## Test data

The integration dataset is:

`src/test-data/geojson/geo-001-duplicate-vertices.geojson`

It contains a repairable polygon duplicate, repairable and non-repairable
multipart line duplicates, an unsafe collapsing line, and a nested point
control geometry.
