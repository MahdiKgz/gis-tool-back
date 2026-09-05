import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processGaps } from "./gaps";
import { processLineTopology } from "./line-topology";
import {
  detectSelfIntersections,
  processSelfIntersections,
} from "./self-intersections";
import { detectSlivers, processSlivers } from "./slivers";
import { detectSpikes, processSpikes } from "./spikes";

const loadCadastralFixture = () =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/cadastral-topology-errors-sample.geojson",
      ),
      "utf8",
    ),
  );

test("applies the six expanded cadastral repairs instead of only reporting them", () => {
  const source = loadCadastralFixture();
  const before = structuredClone(source);
  const polygonInput = {
    ...source,
    // Exclude the independent overlap/orientation cases so this regression
    // isolates the six repair families under test.
    features: source.features.filter((feature: { id: number }) =>
      [1, 2, 4, 5, 6].includes(feature.id),
    ),
  };

  const kinkResult = processSelfIntersections(polygonInput, true);
  assert.equal(kinkResult.report.selfIntersectionsRepaired, 1);
  assert.equal(
    kinkResult.geojson.features.find(
      (feature: { id: number }) => feature.id === 5,
    )?.geometry.type,
    "MultiPolygon",
  );
  assert.equal(detectSelfIntersections(kinkResult.geojson).findings.length, 0);

  const spikeResult = processSpikes(
    kinkResult.geojson,
    { baseToleranceMeters: 0.025 },
    true,
  );
  assert.equal(spikeResult.report.spikesRemoved, 1);
  assert.equal(
    spikeResult.geojson.features.find(
      (feature: { id: number }) => feature.id === 6,
    )?.geometry.coordinates[0].length,
    6,
  );
  assert.equal(
    detectSpikes(spikeResult.geojson, { baseToleranceMeters: 0.025 })
      .findings.length,
    0,
  );

  const sliverResult = processSlivers(
    spikeResult.geojson,
    { sliverAreaThresholdM2: 0.0625 },
    true,
  );
  assert.equal(sliverResult.report.sliversRemoved, 1);
  assert.equal(
    sliverResult.geojson.features.some(
      (feature: { id: number }) => feature.id === 4,
    ),
    false,
  );
  assert.equal(
    detectSlivers(sliverResult.geojson, {
      sliverAreaThresholdM2: 0.0625,
    }).findings.length,
    0,
  );

  const gapResult = processGaps(
    sliverResult.geojson,
    { gapToleranceMeters: 0.075, minimumGapWidthMeters: 0.025 },
    true,
  );
  const repairedGap = gapResult.report.issues.find(
    (issue) => issue.featureId === 1 && issue.relatedFeatureId === 2,
  );
  assert.equal(repairedGap?.status, "Repaired");
  assert.equal(
    processGaps(gapResult.geojson, {
      gapToleranceMeters: 0.075,
      minimumGapWidthMeters: 0.025,
    }).report.gapsFound,
    0,
  );

  const lineInput = {
    ...gapResult.geojson,
    features: [
      ...gapResult.geojson.features,
      source.features.find((feature: { id: number }) => feature.id === 3),
      ...source.features.filter((feature: { id: number }) =>
        [8, 9].includes(feature.id),
      ),
    ],
  };
  const lineResult = processLineTopology(
    lineInput,
    { toleranceMeters: 0.025 },
    true,
  );
  assert.equal(
    lineResult.reports.undershoots.issues.find(
      (issue) => issue.featureId === 8,
    )?.status,
    "Repaired",
  );
  assert.equal(
    lineResult.reports.overshoots.issues.find(
      (issue) => issue.featureId === 9,
    )?.status,
    "Repaired",
  );

  assert.deepEqual(source, before);
  for (const id of [1, 2, 5, 6, 8, 9]) {
    const feature = lineResult.geojson.features.find(
      (candidate: { id: number }) => candidate?.id === id,
    );
    assert.ok(feature, `feature ${id} should preserve its identity`);
    assert.deepEqual(
      feature.properties,
      source.features.find(
        (candidate: { id: number }) => candidate.id === id,
      )?.properties,
    );
  }
});
