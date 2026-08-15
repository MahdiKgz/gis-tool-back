# Dry-Run Gap, Sliver, Undershoot, and Overshoot Validation

SnapGIS reports polygon gaps, sliver polygons, line undershoots, and line
overshoots during the read-only upload analysis. The same detectors are reused
by the healing worker where a conservative automatic repair exists.

## Configuration

All thresholds are derived from the upload `tolerance`, which is supplied in
millimetres:

- Line topology tolerance: `tolerance / 1000` metres.
- Gap tolerance: three times the line topology tolerance, matching the
  worker's second Mapshaper snap pass.
- Sliver area threshold: `(line topology tolerance * 10)²` square metres,
  matching the worker's existing feature-area rule.

The applied values are returned in `report.appliedOptions` as
`lineTopologyToleranceMeters`, `gapToleranceMeters`, and
`sliverAreaThresholdM2`.

## Polygon gaps

The `gaps` check reports `POLYGON_GAP` when two distinct polygon features:

1. do not touch, overlap, or contain one another; and
2. have boundary segments whose true nearest distance is positive and no
   greater than the applied gap tolerance.

Polygon rings are indexed as segments in RBush. Bounding-box expansion is
used only for candidate pruning; a local metric segment-distance calculation
prevents diagonal bounding-box proximity from becoming a false gap. A pair is
reported once at its closest boundary positions. Components belonging to the
same MultiPolygon feature are not treated as dataset gaps.

Gap findings contain both feature IDs/indexes, both polygon and coordinate
paths, the two nearest positions, and their distance in metres. A gap is
marked `AutoRepairAvailable` because the worker applies the corresponding
wider snap-and-clean pass.

## Sliver polygons

The `slivers` check reports `SLIVER_POLYGON` for a positive-area Polygon or
MultiPolygon feature below the applied sliver area threshold. Zero-area
polygons remain the responsibility of GEO-007.

Input slivers are `ManualReview`. Area alone is not enough evidence to delete
a business feature, and the existing GEO-008 policy quarantines tiny input
polygons. The worker may still remove low-area fragments created by later
repair stages, but dry-run does not promise destructive input repair.

## Line undershoots

The `undershoots` check reports `LINE_UNDERSHOOT` when a LineString or
MultiLineString endpoint stops within the metric tolerance of another line
segment without connecting to it. GeometryCollection paths are retained.

Line segments are indexed in RBush, and the closest actual point on each
candidate segment is measured. Only the closest candidate is reported per
endpoint. A disconnected endpoint-to-endpoint pair is deduplicated so healing
does not swap the two original endpoint positions. Healing snaps the endpoint
to the reported target while preserving any additional Z/M ordinates from the
source endpoint.

## Line overshoots

The `overshoots` check reports `LINE_OVERSHOOT` when the terminal portion of a
line crosses another indexed line and continues beyond that intersection by
no more than the metric tolerance.

Distance is measured along the terminal line segments. SnapGIS rejects a
candidate if trimming it would remove half or more of the source line. Healing
then removes every terminal vertex beyond the reported intersection, inserts
the intersection as the new endpoint, and preserves additional source
ordinates. A candidate is left for manual review if an endpoint move would
collapse the source line.

## Relational dry-run output

Gap and line-topology issues include `relatedFeatureIndex` and
`relatedFeatureId`. Issue groups count both features as affected, and
`affectedFeatureCollection` includes both complete source features once. The
existing `relatedCoordinatePath` and `relatedPolygonPath` fields locate the
other side of the relationship.

## Safety and performance

- Dry-run never mutates source coordinates.
- Invalid geometry types, coordinate dimensions, rings, and unsafe polygon
  topology are quarantined before the applicable checks.
- Spatial candidate discovery is O(n log n) with RBush plus work proportional
  to nearby segment candidates; there is no full feature-pair O(n²) scan.
- Gap and sliver detection do not reconstruct geometry.

The integration fixture is
`src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson`.
