import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processSlivers } from "./index";

test("reports slivers from the combined topology fixture without mutation", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processSlivers(fixture, {
    sliverAreaThresholdM2: 0.09,
  });

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.sliversFound, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [2]);
  assert.equal(result.report.issues[0]?.recommendedAction, "ManualReview");
  assert.deepEqual(fixture, before);
});
