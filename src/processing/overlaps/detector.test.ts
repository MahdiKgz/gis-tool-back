import assert from "node:assert/strict";
import test from "node:test";
import { detectPolygonOverlaps } from "./detector";
import { subtractSharedPolygonAreas } from "./repair";
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
  assert.equal(finding.repairable, true);

  const report = buildPolygonOverlapReport(detection);
  assert.deepEqual(report.unresolvedFeatureIndexes, [0, 1]);
  assert.equal(report.issues[0]?.recommendedAction, "AutoRepair");
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

test("removes the shared surface from both parcels while retaining their identities and layers", () => {
  const building = { ...square(0.5, 0.5, 1, "building"), snapgisCadLayer: "ساختمان" };
  const first = { ...square(0, 0, 2, "first"), snapgisCadLayer: "زمین" };
  const second = { ...square(1, 0, 2, "second"), snapgisCadLayer: "زمین" };
  const original = [first, second, building];
  const result = subtractSharedPolygonAreas(original);
  assert.equal(result.overlapsHealed, 1);
  assert.deepEqual(result.features.map(({ id, snapgisCadLayer }) => [id, snapgisCadLayer]), [
    ["first", "زمین"], ["second", "زمین"], ["building", "ساختمان"],
  ]);
  assert.equal(result.features[2], building);
  const longitudes = (feature: typeof first) => feature.geometry.coordinates.flat().map((point) => point[0]!);
  assert.equal(Math.max(...longitudes(result.features[0]!)), 1);
  assert.equal(Math.min(...longitudes(result.features[1]!)), 2);
  assert.equal(Math.max(...longitudes(first)), 2);
  assert.equal(detectPolygonOverlaps({ type: "FeatureCollection", features: result.features }).findings.length, 0);
});

test("retains constant CAD elevation and removes a fully shared inner parcel", () => {
  const elevated = (feature: ReturnType<typeof square>) => ({
    ...feature,
    geometry: { ...feature.geometry, coordinates: feature.geometry.coordinates
      .map((ring) => ring.map((position) => [...position, 18])) },
  });
  const result = subtractSharedPolygonAreas([elevated(square(0, 0, 2, "first")), elevated(square(1, 0, 2, "second"))]);
  assert.equal(result.overlapsHealed, 1);
  assert.ok(result.features.every((feature) => feature.geometry.coordinates.flat().every((point) => point[2] === 18)));

  const contained = [square(0, 0, 2, "outer"), square(0.4, 0.4, 1, "inner")];
  const trimmed = subtractSharedPolygonAreas(contained);
  assert.equal(trimmed.overlapsHealed, 1);
  assert.equal(trimmed.overlapsCritical, 0);
  assert.deepEqual([...trimmed.removedFeatureIndexes], [1]);
  assert.equal(trimmed.features[1]?.geometry, null);
  assert.equal(trimmed.features[0]?.geometry.coordinates.length, 2);
});
