# Dry-Run Shared-Boundary Topology Validation

SnapGIS reports polygon overlaps, gaps, sliver polygons, line undershoots, and
line overshoots during read-only upload analysis. Detection is deliberately
broader than automatic repair: scale-independent or inferred findings remain
manual-review issues unless their coordinate movement falls inside the
configured tolerance.

## Configuration

The upload `tolerance` is supplied in millimetres. SnapGIS derives:

- line topology tolerance: `tolerance / 1000` metres;
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
not touch, overlap, or contain one another and either:

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
gap is `AutoRepairAvailable` only inside the applied gap tolerance. Inferred
shared-boundary gaps are `ManualReview`.

## Sliver polygons

The `slivers` check reports `SLIVER_POLYGON` when a positive-area polygon
component is below the applied area threshold or has compactness below `0.1`.
The compactness gate detects long, narrow cadastral remnants whose total area
is not small. Each finding states whether area, compactness, or both triggered
it. Zero-area polygons remain the responsibility of GEO-007.

Input slivers require manual review. Area or compactness alone is not enough
evidence to delete a business feature.

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
- Invalid geometry types, dimensions, rings, and unsafe polygon topology are
  quarantined before relational checks.
- Spatial candidate discovery is O(n log n) with RBush plus work proportional
  to nearby segment candidates; there is no unconditional feature-pair O(n²)
  scan.
- Findings beyond repair tolerance never advertise automatic repair.

Integration fixtures are
`src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson` and
`src/test-data/geojson/cadastral-topology-errors-sample.geojson`.
