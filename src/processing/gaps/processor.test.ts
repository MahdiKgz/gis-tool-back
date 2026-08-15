import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processGaps } from "./index";

test("processes the combined topology fixture without changing polygons", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processGaps(fixture, { gapToleranceMeters: 0.09 });

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.gapsFound, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [0, 1]);
  assert.deepEqual(fixture, before);
});
