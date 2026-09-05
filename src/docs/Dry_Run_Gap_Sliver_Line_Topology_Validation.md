# Dry-Run Shared-Boundary Topology Validation

SnapGIS reports polygon overlaps, gaps, sliver polygons, line undershoots, and
line overshoots during read-only upload analysis. Detection remains read-only,
while healing can use bounded scale-independent evidence beyond the base
tolerance. Inferred repairs require an unambiguous target and must pass
transactional post-repair topology validation. Dry-run evaluates that same
repair boundary on an immutable candidate and advertises auto repair only when
the candidate would commit successfully.

## Configuration

The upload `tolerance` is supplied in millimetres. SnapGIS derives:

- line topology tolerance: `tolerance / 1000` metres;
- accepted gap width: `tolerance / 1000` metres, inclusive;
- gap repair tolerance: three times the line topology tolerance;
- small-area threshold: `(line topology tolerance * 10)²` square metres;
- sliver compactness threshold: `0.1`, using `4π × area / perimeter²`;
- compactness-only sliver absorption gates: `0.4` dominant shared-perimeter
  ratio, `2` boundary-dominance ratio, and `10` target-to-sliver area ratio;
- maximum inferred shared-boundary gap width: `50` metres, additionally gated
  by a maximum width-to-shared-length ratio of `0.1` and a minimum shared
  length ratio of `0.5`;
- maximum inferred line-boundary error: the lesser of `100` metres or `25%`
  of the source line length; and
- strong outward-ring spike threshold: a shorter-leg-to-base ratio of `10`.

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
least 98% and each edge has exactly one repair partner. Both endpoint pairs
must either be inside the applied gap tolerance or satisfy the inferred bounds:
at most 50 metres and at most 10% of the shared edge length. Healing moves both
matching edges to their shared midpoint so neither parcel is treated as
authoritative.

The candidate must retain positive area, ring orientation, valid holes,
multipart integrity, and a simple boundary. It must not overlap its paired
parcel or increase positive-area overlap with any RBush-selected third-party
polygon. Failed transactional repairs remain unchanged and include a failure
reason. Partial edges, corner proximity, competing partners, and wider
relative gaps remain `ManualReview`.

This separation is intentional: at a 50 mm setting, widths up to and including
50 mm are accepted, a 55 mm complete-edge gap can be repaired inside the
150 mm coordinate radius, and a longer complete-edge cadastral gap can repair
only when the independent absolute, relative-width, uniqueness, and topology
guards all pass.

## Sliver polygons

The `slivers` check reports `SLIVER_POLYGON` when a positive-area polygon
component is below the applied area threshold or has compactness below `0.1`.
The compactness gate detects long, narrow cadastral remnants whose total area
is not small. Each finding states whether area, compactness, or both triggered
it. Zero-area polygons remain the responsibility of GEO-007.

Components below the configured minimum mapping area are
`AutoRepairAvailable`; healing removes the standalone polygon or only the
affected `MultiPolygon` component. A compactness-only sliver is also eligible
for absorption when one non-sliver neighbor owns at least 40% of its perimeter,
that shared boundary is at least twice the runner-up boundary (or there is no
runner-up), the polygons have zero-area boundary contact rather than a small
separation or overlap, and the target is at least ten times larger by area.

Absorption unions the component into that dominant neighbor, conserves area,
keeps the target feature id and properties, and removes only the source
component. The merged target must retain simple components, valid holes, and
valid multipart relationships, and its component count must not increase; a
nearby but disconnected sliver is never merely reclassified as part of the
target. Reports distinguish `Absorbed` from ordinary `Removed` repairs.
Two-sided or weakly adjacent narrow parcels and nested polygons inside a
`GeometryCollection` remain manual.

## Line undershoots

The `undershoots` check reports `LINE_UNDERSHOOT` when a line endpoint stops
within tolerance of another line or polygon boundary. It also reports a
farther polygon boundary when continuing the terminal segment direction
reaches that boundary inside the bounded relative-distance window.

Only the closest candidate is reported per endpoint. Disconnected
endpoint-to-endpoint relationships are deduplicated. Healing moves an endpoint
inside the metric tolerance, or to a directionally inferred polygon boundary
when competing boundary locations are outside the base-tolerance ambiguity
band and no intervening line is crossed. Additional Z/M ordinates are
preserved. The resulting line must remain non-collapsed and simple, and its
referenced target segment must still exist after every repair in the batch.

## Line overshoots

The `overshoots` check reports `LINE_OVERSHOOT` when a terminal line portion
crosses another indexed line within tolerance, or crosses a polygon boundary
and continues for a bounded distance relative to total line length.

Distance is measured along terminal line segments. SnapGIS rejects a candidate
if trimming would remove half or more of the source line. A directionally
inferred polygon-boundary overshoot can be trimmed when the target is unique
within the ambiguity band and no nearer line intersection exists. The
resulting line must remain non-collapsed and simple. Dependent endpoint edits
are rolled back if another repair trims away their target segment.

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
- Failed repair-boundary validation is surfaced as manual review with a
  machine-readable failure reason instead of claiming a repair occurred.
- Worker line healing uses final repaired polygon boundaries, matching the
  full-context dry-run detector rather than evaluating an isolated line-only
  collection.

Integration fixtures are
`src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson` and
`src/test-data/geojson/cadastral-topology-errors-sample.geojson`. The focused
50 mm healing regression is
`src/test-data/geojson/gap-healing-50mm.geojson`.
