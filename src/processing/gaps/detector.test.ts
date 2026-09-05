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

test("offers a narrow complete shared-boundary gap for inferred repair", () => {
  const detection = detectGaps(
    {
      type: "FeatureCollection",
      features: [
        square(51.38, 35.68, 0.002, "west"),
        square(51.3822, 35.68, 0.002, "east"),
      ],
    },
    { gapToleranceMeters: 0.075 },
  );

  assert.equal(detection.findings.length, 1);
  const finding = detection.findings[0]!;
  assert.equal(finding.detectionMode, "SharedBoundaryPattern");
  assert.ok(finding.distanceMeters > 18 && finding.distanceMeters < 19);
  assert.ok(finding.sharedBoundaryRatio! > 0.99);
  assert.ok(finding.gapWidthToSharedBoundaryRatio! < 0.1);
  assert.equal(finding.repairable, true);

  const report = buildGapReport(detection, 0.075);
  assert.equal(report.issues[0]?.recommendedAction, "AutoRepair");
});

test("keeps an inferred repair manual when one edge has competing partners", () => {
  const west = square(51.38, 35.68, 0.002, "west");
  const east = square(51.3822, 35.68, 0.002, "east");
  const duplicateEast = structuredClone(east);
  duplicateEast.id = "duplicate-east";
  const detection = detectGaps(
    {
      type: "FeatureCollection",
      features: [west, east, duplicateEast],
    },
    { gapToleranceMeters: 0.075 },
  );

  const westFindings = detection.findings.filter(
    (finding) => finding.featureId === "west",
  );
  assert.equal(westFindings.length, 2);
  assert.ok(westFindings.every((finding) => !finding.repairable));
});

test("a nearby partial-edge candidate also makes an inferred target ambiguous", () => {
  const partial = {
    type: "Feature",
    id: "partial",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [51.3820005, 35.6808],
        [51.3821, 35.6808],
        [51.3821, 35.6812],
        [51.3820005, 35.6812],
        [51.3820005, 35.6808],
      ]],
    },
  };
  const detection = detectGaps(
    {
      type: "FeatureCollection",
      features: [
        square(51.38, 35.68, 0.002, "west"),
        square(51.3822, 35.68, 0.002, "east"),
        partial,
      ],
    },
    { gapToleranceMeters: 0.075 },
  );

  const inferred = detection.findings.find(
    (finding) => finding.featureId === "west" && finding.relatedFeatureId === "east",
  );
  const partialFinding = detection.findings.find(
    (finding) => finding.relatedFeatureId === "partial",
  );
  assert.ok(inferred);
  assert.ok(partialFinding);
  assert.equal(inferred.repairable, false);
  assert.equal(partialFinding.repairable, false);
});

test("does not infer a gap from a short partial boundary alignment", () => {
  const detection = detectGaps(
    {
      type: "FeatureCollection",
      features: [
        square(51.38, 35.68, 0.002, "west"),
        square(51.3822, 35.6815, 0.002, "partial"),
      ],
    },
    { gapToleranceMeters: 0.075 },
  );

  assert.deepEqual(detection.findings, []);
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
  assert.throws(
    () =>
      detectGaps(
        { type: "FeatureCollection", features: [] },
        { gapToleranceMeters: 1, minimumGapWidthMeters: -0.001 },
      ),
    /finite non-negative/,
  );
  assert.throws(
    () =>
      detectGaps(
        { type: "FeatureCollection", features: [] },
        {
          gapToleranceMeters: 1,
          maxGapWidthToSharedBoundaryRatio: 2,
        },
      ),
    /between 0 and 1/,
  );
});
