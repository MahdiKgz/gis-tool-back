import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processCoordinatePrecision } from "./index";

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
