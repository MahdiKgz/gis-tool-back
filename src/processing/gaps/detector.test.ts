import assert from "node:assert/strict";
import test from "node:test";
import { detectGaps } from "./detector";
import { buildGapReport } from "./report";

const square = (x: number, y: number, size: number, id: string) => ({
  type: "Feature",
  id,
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [[
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ]],
  },
});

test("detects and locates a real polygon gap within tolerance", () => {
  const detection = detectGaps(
    {
      type: "FeatureCollection",
      features: [
        square(0, 0, 0.001, "west"),
        square(0.0010005, 0, 0.001, "east"),
      ],
    },
    { gapToleranceMeters: 0.09 },
  );

  assert.equal(detection.polygonComponentsScanned, 2);
  assert.equal(detection.findings.length, 1);
  const gap = detection.findings[0]!;
  assert.equal(gap.featureId, "west");
  assert.equal(gap.relatedFeatureId, "east");
  assert.ok(gap.distanceMeters > 0.05 && gap.distanceMeters < 0.06);
  assert.deepEqual(gap.polygonPath, []);
  assert.equal(gap.repairable, true);

  const report = buildGapReport(detection, 0.09);
  assert.deepEqual(report.unresolvedFeatureIndexes, [0, 1]);
});

test("rejects bbox-near diagonal polygons outside the true distance", () => {
  const detection = detectGaps(
    {
      type: "FeatureCollection",
      features: [
        square(0, 0, 0.001, "southwest"),
        square(0.0010007, 0.0010007, 0.001, "northeast"),
      ],
    },
    { gapToleranceMeters: 0.09 },
  );

  assert.equal(detection.findings.length, 0);
});

test("does not report touching, overlapping, or contained polygons as gaps", () => {
  const cases = [
    [square(0, 0, 0.001, "a"), square(0.001, 0, 0.001, "touching")],
    [square(0, 0, 0.001, "a"), square(0.0009, 0, 0.001, "overlap")],
    [square(0, 0, 0.01, "a"), square(0.004, 0.004, 0.001, "inside")],
  ];

  for (const features of cases) {
    assert.equal(
      detectGaps(
        { type: "FeatureCollection", features },
        { gapToleranceMeters: 20 },
      ).findings.length,
      0,
    );
  }
});

test("does not treat components of one MultiPolygon as a dataset gap", () => {
  const first = square(0, 0, 0.001, "unused").geometry.coordinates;
  const second = square(0.0010005, 0, 0.001, "unused").geometry.coordinates;
  const result = detectGaps(
    {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "multipart",
          properties: {},
          geometry: { type: "MultiPolygon", coordinates: [first, second] },
        },
      ],
    },
    { gapToleranceMeters: 0.09 },
  );

  assert.equal(result.polygonComponentsScanned, 2);
  assert.equal(result.findings.length, 0);
});

test("a zero tolerance scans components but disables gap findings", () => {
  const result = detectGaps(
    {
      type: "FeatureCollection",
      features: [square(0, 0, 0.001, "one")],
    },
    { gapToleranceMeters: 0 },
  );
  assert.equal(result.polygonComponentsScanned, 1);
  assert.equal(result.findings.length, 0);
});

test("rejects invalid gap tolerances", () => {
  assert.throws(
    () =>
      detectGaps(
        { type: "FeatureCollection", features: [] },
        { gapToleranceMeters: -1 },
      ),
    /finite non-negative/,
  );
});
