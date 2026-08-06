# GEO-002 Invalid Ring Detection

## Scope

The invalid-ring stage validates every ring in `Polygon`, `MultiPolygon`, and
nested `GeometryCollection` geometries immediately after input parsing. It
runs before duplicate-vertex and topology processing.

Detection is linear in the number of positions and distinguishes:

- **Unclosed rings**: otherwise well-formed coordinate arrays whose final
  position does not equal the first position.
- **Corrupted rings**: missing/non-array rings, empty rings, or rings
  containing invalid positions. Positions require at least two finite numeric
  ordinates.
- **Insufficient rings**: rings with fewer than three distinct vertices,
  excluding the required closing position.

Coordinate comparison uses every ordinate, preserving Z or M dimensions.

## Repair policy

An unclosed ring is closed automatically only when it contains at least three
distinct valid vertices and no corrupted positions. Repair appends a copy of
the first position and does not mutate the input object.

Corrupted and insufficient rings are never guessed or destructively altered.
Features containing unresolved ring issues are preserved in the output but
quarantined from Turf, Mapshaper, and coordinate truncation stages that assume
valid polygon structure.

Ring validation runs before duplicate-vertex repair. This ordering allows an
open ring to be closed first and then safely deduplicated while retaining the
required closure.

## Validation report

Worker results expose:

- `invalidRingsFound`
- `invalidRingsRepaired`
- `invalidRingIssuesUnresolved`
- `invalidRingValidationReport`

The detailed report includes scanned and invalid ring counts, issue totals by
type, repaired rings, unresolved feature indexes, and issue entries containing
the feature identifier, geometry collection path, coordinate path, ring role,
position counts, invalid coordinate indexes, corruption reason, repair
eligibility, final status, and recommended action.

## Test data

The integration dataset is:

`src/test-data/geojson/geo-002-invalid-rings.geojson`

It contains a repairable exterior ring, an insufficient ring, a corrupted
hole in a `MultiPolygon`, and a repairable polygon nested in a
`GeometryCollection`.
