# GEO-013 Coordinate Precision Validation

## Scope

GEO-013 validates coordinate precision and floating-point robustness before
output rounding or topology operations can merge distinct vertices.

## Detection

With a configurable maximum decimal precision, SnapGIS reports:

- **Excess precision** when rounding changes an ordinate.
- **Rounding collision** when distinct XY positions in the same coordinate
  sequence map to one rounded grid position.
- **Unsafe magnitude** when the rounded coordinate's scaled grid index
  exceeds JavaScript's safe-integer range.

Scientific notation is handled deterministically. Collision detection is
linear in position count, uses one hash map per coordinate sequence, compares
topology in XY, and does not misclassify an exact polygon-ring closure.

`maxDecimalPlaces` must be an integer from 0 through 15 and defaults to 9.

## Policy and output integration

Excess decimal precision is automatically normalized at output when no
positions collide on the rounding grid and the scaled coordinate magnitude is
safe. Those findings are reported as `AutoRepairAvailable` and remain eligible
for topology healing. Features with a rounding collision or unsafe magnitude
are preserved without rounding, reported for manual review, and quarantined
from downstream topology.

Compliant output continues to use nine-decimal rounding. The output helper
now retains every ordinate instead of Turf's default three-ordinate limit, so
valid Z/M and higher-dimensional positions accepted by GEO-011 are not
silently truncated.

Worker results expose:

- `coordinatePrecisionIssuesFound`
- `excessiveCoordinateValues`
- `coordinateRoundingCollisions`
- `unsafeCoordinateMagnitudeValues`
- `coordinatePrecisionIssuesUnresolved`
- `coordinatePrecisionValidationReport`
- `appliedCoordinatePrecision`

## Test data

`src/test-data/geojson/geo-013-coordinate-precision.geojson` covers excessive
precision, a rounding collision, unsafe magnitude, and a compliant
nine-decimal control. Unit tests also cover scientific notation, exact ring
closure, invalid configuration, and preservation of fourth and later
ordinates during output rounding.
