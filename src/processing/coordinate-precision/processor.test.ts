import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  coordinatePrecisionQuarantineFeatureIndexes,
  processCoordinatePrecision,
} from "./index";

test("processes the GEO-013 fixture without mutating input", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-013-coordinate-precision.geojson",
      ),
      "utf8",
    ),
  );
  const result = processCoordinatePrecision(fixture, {
    maxDecimalPlaces: 9,
  });

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.excessiveCoordinateValues, 2);
  assert.equal(result.report.roundingCollisions, 1);
  assert.equal(result.report.unsafeMagnitudeValues, 1);
  assert.deepEqual(
    result.report.unresolvedFeatureIndexes,
    [0, 1, 2],
  );
});

test("quarantines only precision defects that make rounding unsafe", () => {
  const result = processCoordinatePrecision(
    {
      type: "FeatureCollection",
      features: [
        {
          geometry: {
            type: "Point",
            coordinates: [51.12345678912, 35.7],
          },
        },
        {
          geometry: {
            type: "LineString",
            coordinates: [[0, 0], [0.0000000004, 0], [1, 0]],
          },
        },
      ],
    },
    { maxDecimalPlaces: 9 },
  );

  assert.ok(result.report.excessiveCoordinateValues > 0);
  assert.equal(result.report.roundingCollisions, 1);
  assert.equal(
    result.report.issues.find(
      (issue) =>
        issue.featureIndex === 0 &&
        issue.code === "EXCESSIVE_COORDINATE_PRECISION",
    )?.recommendedAction,
    "AutoRepair",
  );
  assert.deepEqual(
    coordinatePrecisionQuarantineFeatureIndexes(result.report),
    [1],
  );
});
