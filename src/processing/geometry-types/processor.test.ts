import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processGeometryTypes } from "./index";

test("processes the GEO-010 fixture without mutating geometry", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-010-geometry-types.geojson",
      ),
      "utf8",
    ),
  );
  const result = processGeometryTypes(fixture);

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.invalidGeometryTypesFound, 3);
  assert.deepEqual(
    result.report.unresolvedFeatureIndexes,
    [1, 2, 3],
  );
  assert.deepEqual(
    result.report.issues[2]?.geometryCollectionPath,
    [1],
  );
});
