# GEO-003 Ring Closure Validation

## Scope

The ring-closure stage detects open exterior and interior rings in `Polygon`,
`MultiPolygon`, and nested `GeometryCollection` geometries. It compares the
complete first and final positions exactly, including optional Z or M
ordinates.

The closure module owns detection, repair, and reporting. GEO-002 reuses its
repair operation so invalid-ring and ring-closure processing apply one
consistent, non-duplicated closure policy.

## Detection

Traversal and detection are linear in the number of ring positions. An open
ring is reported when both endpoints are valid finite positions and they are
not exactly equal.

Each finding includes:

- Feature identifier and index
- Geometry collection and coordinate paths
- Exterior or interior ring role
- Position and distinct-vertex counts
- Invalid coordinate indexes
- Repair eligibility and blocking reason

Rings whose endpoints cannot be evaluated are left to GEO-002 corrupted-ring
validation. Detectably open rings with malformed interior positions or fewer
than three distinct vertices are reported but blocked from automatic repair.

## Repair policy

Only an open ring containing at least three distinct, finite positions is
closed automatically. Repair appends a new copy of the complete first
position, preserves coordinate dimensions, and does not mutate input objects.

The repair operation performs its own defensive validation in addition to the
detector gate. Corrupted or insufficient targets remain unchanged and are not
reported as closed.

## Pipeline integration

The worker captures closure findings from the parsed input, performs the
shared GEO-002/GEO-003 repair once, and builds both validation reports from
that repair result. Ring closure runs before duplicate-vertex processing so
redundant vertices can then be removed without breaking the required closure.

Worker results expose:

- `openRingsFound`
- `ringsAutoClosed`
- `openRingsUnresolved`
- `ringClosureValidationReport`

## Test data

The integration dataset is:

`src/test-data/geojson/geo-003-ring-closure.geojson`

It covers a three-dimensional exterior ring, an interior `MultiPolygon` ring,
corrupted and insufficient open rings, and a polygon nested in a
`GeometryCollection`.
