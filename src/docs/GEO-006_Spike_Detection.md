# GEO-006 Spike Detection

## Scope

GEO-006 detects narrow backtracks in `LineString`, `MultiLineString`,
`Polygon`, `MultiPolygon`, and nested `GeometryCollection` coordinate
sequences.

## Detection

For each non-terminal line vertex and each cyclic ring vertex, SnapGIS
measures:

- the geodesic distance between the two shoulder vertices;
- both shoulder-to-tip leg lengths; and
- the tip angle using the triangle side lengths.

A vertex is a spike when its tip angle is at most 10 degrees by default and
each leg is at least three times the shoulder width. These scale-independent
shape gates avoid classifying ordinary sharp corners or densely sampled
curves. The configured shoulder-width tolerance determines repair
eligibility, not whether the anomaly is visible in validation output.

Detection is linear in coordinate count and preserves complete positions,
including optional Z or M values.

## Repair policy

Detected spikes whose shoulder width is inside `baseToleranceMeters` are
high-confidence local backtracks. Their tip is removed when the target and
both neighboring positions still match the detection snapshot. Wider
shape-matched spikes are reported for manual review and never removed.

Line repairs must retain at least two coordinates. Ring repairs must retain
closure, at least three distinct vertices, determinate unchanged orientation,
and no self-intersection. Multiple tips in one sequence are applied as one
immutable update; if the resulting ring fails validation, none are removed.

## Configuration and pipeline

`baseToleranceMeters` is finite, non-negative, and defaults to `0.025`.
`maxTipAngleDegrees` and `minLegToBaseRatio` are also available for direct
processor use.

The worker applies the existing job tolerance converted from millimetres to
metres. GEO-006 runs after GEO-005 and before duplicate, overlap, line
healing, and Mapshaper operations. Unresolved findings are retained and
quarantined.

Worker results expose:

- `spikesFound`
- `spikesRemoved`
- `spikesUnresolved`
- `spikeValidationReport`
- `appliedSpikeBaseToleranceMeters`

## Test data

`src/test-data/geojson/geo-006-spikes.geojson` covers line and polygon spikes,
an ordinary-corner control, immutable repair, ring validity, configuration,
disabled repair, and stale-target rejection.
