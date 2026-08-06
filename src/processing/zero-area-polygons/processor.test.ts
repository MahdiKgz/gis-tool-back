import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processZeroAreaPolygons } from "./index";

test("processes the GEO-007 integration fixture without repair", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-007-zero-area-polygons.geojson",
      ),
      "utf8",
    ),
  );
  const result = processZeroAreaPolygons(fixture);

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.polygonsScanned, 4);
  assert.equal(result.report.zeroAreaPolygonsFound, 2);
  assert.equal(result.report.unresolvedIssues, 2);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [0, 2]);
});
