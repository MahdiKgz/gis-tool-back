import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSliverAreaThresholdM2,
  detectSlivers,
} from "./detector";

const polygonFeature = (id: string, ring: number[][]) => ({
  type: "Feature",
  id,
  properties: {},
  geometry: { type: "Polygon", coordinates: [ring] },
});

test("detects positive-area polygon features below the worker threshold", () => {
  const result = detectSlivers(
    {
      type: "FeatureCollection",
      features: [
        polygonFeature("sliver", [
          [0, 0],
          [0.000001, 0],
          [0.000001, 0.000001],
          [0, 0.000001],
          [0, 0],
        ]),
        polygonFeature("normal", [
          [1, 0],
          [1.001, 0],
          [1.001, 0.001],
          [1, 0.001],
          [1, 0],
        ]),
        polygonFeature("zero", [
          [2, 0],
          [2.001, 0],
          [2.002, 0],
          [2, 0],
        ]),
      ],
    },
    { sliverAreaThresholdM2: 0.09 },
  );

  assert.equal(result.polygonFeaturesScanned, 3);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.featureId, "sliver");
  assert.equal(result.findings[0]?.code, "SLIVER_POLYGON");
  assert.equal(result.findings[0]?.repairable, false);
});

test("derives the same sliver threshold used by healing", () => {
  assert.equal(computeSliverAreaThresholdM2(0.03), 0.09);
});

test("rejects invalid sliver thresholds", () => {
  assert.throws(
    () =>
      detectSlivers(
        { type: "FeatureCollection", features: [] },
        { sliverAreaThresholdM2: Number.NaN },
      ),
    /finite non-negative/,
  );
});
