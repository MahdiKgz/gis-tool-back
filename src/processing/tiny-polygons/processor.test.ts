import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processTinyPolygons } from "./index";

test("processes the GEO-008 integration fixture without repair", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-008-tiny-polygons.geojson",
      ),
      "utf8",
    ),
  );
  const result = processTinyPolygons(fixture, {
    tinyPolygonAreaM2: 1,
  });

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.polygonsScanned, 3);
  assert.equal(result.report.tinyPolygonsFound, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [0]);
  assert.equal(result.report.appliedTinyPolygonAreaM2, 1);
});
