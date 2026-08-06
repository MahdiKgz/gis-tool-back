import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processGeometryDimensions } from "./index";

test("processes the GEO-011 fixture without mutating input", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-011-geometry-dimensions.geojson",
      ),
      "utf8",
    ),
  );
  const result = processGeometryDimensions(fixture);

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.invalidDimensionsFound, 1);
  assert.equal(result.report.inconsistentDimensionsFound, 1);
  assert.equal(result.report.invalidCoordinateValuesFound, 1);
  assert.deepEqual(
    result.report.unresolvedFeatureIndexes,
    [1, 2, 3],
  );
});
