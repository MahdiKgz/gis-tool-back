# GEO-005 Invalid Hole Validation

## Scope

The invalid-hole stage validates interior rings in `Polygon`,
`MultiPolygon`, and nested `GeometryCollection` geometries. It runs after
ring structure, closure, duplicate-vertex, and orientation validation so
malformed rings remain the responsibility of GEO-001 through GEO-004.

The stage detects:

- holes outside or partially outside their exterior ring;
- strictly nested holes;
- duplicate holes independent of starting vertex or winding;
- self-intersecting holes;
- holes touching the exterior boundary;
- holes below the configured area threshold; and
- holes whose area exceeds their exterior ring's area.

## Detection

Containment checks every hole vertex and uses boundary intersections as a
second gate. This catches concave-exterior crossings where every hole vertex
is inside but an edge leaves the polygon.

Self-intersecting holes are reported before containment or area
classification. Their area is treated as indeterminate so a bow-tie ring
does not create misleading tiny or oversized findings.

Duplicate-hole signatures are invariant to cyclic rotation and winding.
Booth's least-rotation algorithm builds them in linear time without rounding
coordinates or allocating every possible rotation.

Nested-hole detection builds one RBush index per polygon. Bounding-box
containment narrows candidate pairs before exact ring containment, and the
smallest containing hole is reported as the immediate parent.

Exterior area is calculated once per polygon and reused for every hole.
Structurally invalid or open rings are deferred to the earlier validation
stages instead of being interpreted again.

## Repair policy

Automatic repair is deliberately conservative:

- A proven outside hole is removed.
- A hole below the configured threshold is removed.
- Incorrect interior-ring orientation is normalized by the GEO-004 module.
- Nested, duplicate, self-intersecting, boundary-touching, and otherwise
  ambiguous holes are retained for manual review.

When a hole has more than one finding, removing it resolves every finding
attached to that ring. Removal is immutable and grouped per polygon so
multiple original ring indexes can be removed safely in one update.

The repair boundary verifies the current ring's canonical signature before
removal. A stale finding cannot remove a different ring that later occupied
the same coordinate path.

## Configuration

`processInvalidHoles` accepts `tinyHoleAreaM2`, a finite non-negative area in
square metres. Its standalone default is `0.01`.

The worker uses the existing tolerance-derived sliver threshold:

`tinyHoleAreaM2 = (toleranceMeters * 10)²`

This keeps small-polygon and small-hole classification consistent for a
single job. A threshold of zero disables tiny-hole findings.

## Pipeline integration

GEO-005 runs before polygon duplicate, overlap, sliver, and Mapshaper work.
Features with unresolved invalid-hole findings are preserved in output and
quarantined from those downstream topology operations.

Worker results expose:

- `invalidHolesFound`
- `holesRemoved`
- `tinyHolesRemoved`
- `outsideHolesRemoved`
- `holeOrientationsNormalized`
- `invalidHoleIssuesUnresolved`
- `invalidHoleValidationReport`
- `appliedTinyHoleAreaM2`

Each issue includes its feature identifier, geometry-collection path,
polygon and ring paths, related-hole path when applicable, measured areas,
repair eligibility, final status, and recommended action.

## Test data

The integration dataset is:

`src/test-data/geojson/geo-005-invalid-holes.geojson`

It covers every GEO-005 detection category, safe removals, orientation
normalization, unresolved-feature quarantine, and immutable processing.
Additional tests cover concave containment, exact duplicate precision,
multipart and nested geometry paths, disabled repair, malformed-ring
deferral, and stale repair targets.
