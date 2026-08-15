import assert from "node:assert/strict";
import test from "node:test";
import { detectPolygonOverlaps } from "./detector";
import { buildPolygonOverlapReport } from "./report";

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

test("reports positive-area overlap between distinct polygon features", () => {
  const detection = detectPolygonOverlaps({
    type: "FeatureCollection",
    features: [
      square(51.38, 35.68, 0.002, "reference"),
      square(51.38, 35.6815, 0.002, "overlapping"),
    ],
  });

  assert.equal(detection.polygonComponentsScanned, 2);
  assert.equal(detection.candidatePairsChecked, 1);
  assert.equal(detection.findings.length, 1);
  const finding = detection.findings[0]!;
  assert.equal(finding.code, "POLYGON_OVERLAP");
  assert.equal(finding.featureId, "reference");
  assert.equal(finding.relatedFeatureId, "overlapping");
  assert.ok(finding.overlapAreaM2 > 10_000);
  assert.ok(finding.overlapRatio > 0.2 && finding.overlapRatio < 0.3);
  assert.equal(finding.repairable, false);

  const report = buildPolygonOverlapReport(detection);
  assert.deepEqual(report.unresolvedFeatureIndexes, [0, 1]);
  assert.equal(report.issues[0]?.recommendedAction, "ManualReview");
});

test("does not report exact shared boundaries or separated polygons", () => {
  const detection = detectPolygonOverlaps({
    type: "FeatureCollection",
    features: [
      square(0, 0, 0.001, "west"),
      square(0.001, 0, 0.001, "touching"),
      square(0.003, 0, 0.001, "separate"),
    ],
  });

  assert.deepEqual(detection.findings, []);
});
