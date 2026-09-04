# Dry-Run Shared-Boundary Topology Validation

SnapGIS reports polygon overlaps, gaps, sliver polygons, line undershoots, and
line overshoots during read-only upload analysis. Detection is deliberately
broader than automatic repair: scale-independent or inferred findings remain
manual-review issues unless their coordinate movement falls inside the
configured tolerance.

## Configuration

The upload `tolerance` is supplied in millimetres. SnapGIS derives:

- line topology tolerance: `tolerance / 1000` metres;
- accepted gap width: `tolerance / 1000` metres, inclusive;
- gap repair tolerance: three times the line topology tolerance;
- small-area threshold: `(line topology tolerance * 10)²` square metres;
- sliver compactness threshold: `0.1`, using `4π × area / perimeter²`;
- maximum inferred shared-boundary gap width: `50` metres, additionally gated
  by a maximum width-to-shared-length ratio of `0.1` and a minimum shared
  length ratio of `0.5`; and
- maximum inferred line-boundary error: the lesser of `100` metres or `25%`
  of the source line length.

The applied values are returned under `report.appliedOptions`.

## Polygon overlaps

The `overlaps` check reports `POLYGON_OVERLAP` for a positive-area
intersection between components owned by distinct features. Polygon component
bounds are indexed with RBush before exact Turf intersection. Exact shared
edges and floating-point area artefacts at or below `1e-8 m²` are ignored.

Findings include overlap area, overlap ratio against the smaller component,
bounding box, and both feature/component paths. Input overlaps require manual
review.

## Polygon gaps and shared boundaries

The `gaps` check reports `POLYGON_GAP` when two distinct polygon features do
not touch, overlap, or contain one another, their separation is greater than
the accepted gap width, and either:

1. their true nearest boundary distance is inside the applied repair
   tolerance; or
2. long, near-parallel facing boundaries form a gap that is narrow relative
   to their shared length and below the inferred-width cap.

Polygon rings are indexed as segments in RBush. Bounding-box expansion is
used only for candidate pruning; local metric calculations verify actual
distance, parallelism, and longitudinal overlap. Components belonging to one
MultiPolygon feature are not treated as dataset gaps.

Findings contain both feature IDs/indexes, both polygon and coordinate paths,
nearest positions, distance, detection mode, and shared-boundary metrics. A
gap is `AutoRepairAvailable` only when its full exterior edges overlap by at
least 98%, both endpoint pairs are inside the applied gap tolerance, and the
repair passes positive-area, self-intersection, and overlap guards. Healing
moves both matching edges to their shared midpoint so neither parcel is
treated as authoritative. Partial edges, corner proximity, holes, and inferred
gaps beyond tolerance remain `ManualReview`.

This separation is intentional: at a 50 mm setting, widths up to and including
50 mm are accepted, while a 55 mm complete-edge gap is reported and can still
be repaired inside the 150 mm repair radius.

## Sliver polygons

The `slivers` check reports `SLIVER_POLYGON` when a positive-area polygon
component is below the applied area threshold or has compactness below `0.1`.
The compactness gate detects long, narrow cadastral remnants whose total area
is not small. Each finding states whether area, compactness, or both triggered
it. Zero-area polygons remain the responsibility of GEO-007.

Components below the configured minimum mapping area are
`AutoRepairAvailable`; healing removes the standalone polygon or only the
affected `MultiPolygon` component. Compactness-only findings stay
`ManualReview`, because a long narrow polygon can be a legitimate parcel and
cannot be reconstructed safely from shape alone. Nested polygons inside a
`GeometryCollection` also remain manual.

## Line undershoots

The `undershoots` check reports `LINE_UNDERSHOOT` when a line endpoint stops
within tolerance of another line or polygon boundary. It also reports a
farther polygon boundary when continuing the terminal segment direction
reaches that boundary inside the bounded relative-distance window.

Only the closest candidate is reported per endpoint. Disconnected
endpoint-to-endpoint relationships are deduplicated. Healing moves an endpoint
only when the target is inside the metric tolerance and preserves additional
Z/M ordinates. Directionally inferred findings require manual review.

## Line overshoots

The `overshoots` check reports `LINE_OVERSHOOT` when a terminal line portion
crosses another indexed line within tolerance, or crosses a polygon boundary
and continues for a bounded distance relative to total line length.

Distance is measured along terminal line segments. SnapGIS rejects a candidate
if trimming would remove half or more of the source line. Healing occurs only
inside tolerance; inferred polygon-boundary overshoots remain manual.

## Relational output

Overlap, gap, and line-topology issues include `relatedFeatureIndex`,
`relatedFeatureId`, and applicable related coordinate or polygon paths. Issue
groups count both features as affected, and `affectedFeatureCollection`
contains both complete source features once.

## Safety and performance

- Dry-run never mutates source coordinates.
- Ordinary excess decimal precision is `AutoRepairAvailable` and does not
  quarantine an otherwise safe feature from healing. Rounding collisions and
  unsafe numeric magnitudes remain manual and quarantined.
- Invalid geometry types, dimensions, rings, and unsafe polygon topology are
  quarantined before relational checks.
- Spatial candidate discovery is O(n log n) with RBush plus work proportional
  to nearby segment candidates; there is no unconditional feature-pair O(n²)
  scan.
- Findings beyond repair tolerance never advertise automatic repair.

Integration fixtures are
`src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson` and
`src/test-data/geojson/cadastral-topology-errors-sample.geojson`. The focused
50 mm healing regression is
`src/test-data/geojson/gap-healing-50mm.geojson`.
