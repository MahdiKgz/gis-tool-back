import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processMultipartIntegrity } from "./index";

test("processes the GEO-012 fixture without mutating input", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-012-multipart-integrity.geojson",
      ),
      "utf8",
    ),
  );
  const result = processMultipartIntegrity(fixture);

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.multiPolygonsScanned, 4);
  assert.equal(result.report.invalidMultiPolygonsFound, 3);
  assert.equal(result.report.overlappingPolygonComponents, 1);
  assert.equal(result.report.duplicatePolygonComponents, 1);
  assert.equal(result.report.invalidPolygonComponents, 1);
  assert.deepEqual(
    result.report.unresolvedFeatureIndexes,
    [1, 2, 3],
  );
});
