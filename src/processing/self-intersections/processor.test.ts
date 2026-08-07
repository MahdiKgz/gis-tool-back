import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processSelfIntersections } from "./index";

test("processes the self-intersection fixture without mutating it", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/dry-run-self-intersections.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);

  const result = processSelfIntersections(fixture);

  assert.equal(result.geojson, fixture);
  assert.deepEqual(result.geojson, before);
  assert.equal(result.report.valid, false);
  assert.equal(result.report.selfIntersectionsFound, 2);
  assert.equal(result.report.crossingsFound, 2);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [1, 2]);
  assert.deepEqual(
    result.report.issues.map((issue) => ({
      featureId: issue.featureId,
      geometryCollectionPath: issue.geometryCollectionPath,
      polygonPath: issue.polygonPath,
      coordinatePath: issue.coordinatePath,
    })),
    [
      {
        featureId: "bow-tie",
        geometryCollectionPath: [],
        polygonPath: [],
        coordinatePath: [0, 0],
      },
      {
        featureId: "nested-multipolygon",
        geometryCollectionPath: [0],
        polygonPath: [1],
        coordinatePath: [1, 0, 0],
      },
    ],
  );
});
