import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  capturePolygonAreaBaseline,
  processCollapsedPolygons,
} from "./index";

const fixture = (name: string) =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), "src/test-data/geojson", name),
      "utf8",
    ),
  );

test("processes the GEO-009 before/after integration fixtures", () => {
  const before = fixture("geo-009-collapse-before.geojson");
  const after = fixture("geo-009-collapse-after.geojson");
  const result = processCollapsedPolygons(
    capturePolygonAreaBaseline(before),
    after,
  );

  assert.equal(result.geojson, after);
  assert.equal(result.report.baselinePolygonsScanned, 2);
  assert.equal(result.report.collapsedPolygonsFound, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [0]);
});
