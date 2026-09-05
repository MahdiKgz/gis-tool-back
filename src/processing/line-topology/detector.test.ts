import assert from "node:assert/strict";
import test from "node:test";
import { detectLineTopology } from "./detector";

const line = (id: string, coordinates: number[][]) => ({
  type: "Feature",
  id,
  properties: {},
  geometry: { type: "LineString", coordinates },
});

test("distinguishes an undershoot from an overshoot at line endpoints", () => {
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        line("undershoot", [[0, 0], [0.0009998, 0]]),
        line("undershoot-target", [[0.001, -0.001], [0.001, 0.001]]),
        line("overshoot", [[0.01, 0], [0.0110002, 0]]),
        line("overshoot-target", [[0.011, -0.001], [0.011, 0.001]]),
      ],
    },
    { toleranceMeters: 0.03 },
  );

  assert.equal(result.linePartsScanned, 4);
  assert.equal(result.undershoots.length, 1);
  assert.equal(result.overshoots.length, 1);
  const undershoot = result.undershoots[0]!;
  assert.equal(undershoot.featureId, "undershoot");
  assert.equal(undershoot.relatedFeatureId, "undershoot-target");
  assert.deepEqual(undershoot.coordinatePath, [1]);
  assert.deepEqual(undershoot.targetPosition, [0.001, 0]);
  assert.ok(undershoot.distanceMeters < 0.03);
  const overshoot = result.overshoots[0]!;
  assert.equal(overshoot.featureId, "overshoot");
  assert.equal(overshoot.relatedFeatureId, "overshoot-target");
  assert.deepEqual(overshoot.coordinatePath, [1]);
  assert.deepEqual(overshoot.targetPosition, [0.011, 0]);
  assert.ok(overshoot.overrunDistanceMeters < 0.03);
});

test("does not report an endpoint that already connects to another line", () => {
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        line("connected", [[0, 0], [0.001, 0]]),
        line("target", [[0.001, -0.001], [0.001, 0.001]]),
      ],
    },
    { toleranceMeters: 0.03 },
  );

  assert.deepEqual(result.undershoots, []);
  assert.deepEqual(result.overshoots, []);
});

test("detects directional under- and overshoots against polygon boundaries", () => {
  const polygon = (id: string, coordinates: number[][]) => ({
    type: "Feature",
    id,
    properties: {},
    geometry: { type: "Polygon", coordinates: [coordinates] },
  });
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        polygon("P-101", [
          [51.38, 35.68],
          [51.382, 35.68],
          [51.382, 35.682],
          [51.38, 35.682],
          [51.38, 35.68],
        ]),
        polygon("P-103", [
          [51.38, 35.6815],
          [51.382, 35.6815],
          [51.382, 35.6835],
          [51.38, 35.6835],
          [51.38, 35.6815],
        ]),
        line("R-201", [[51.378, 35.681], [51.3817, 35.681]]),
        line("R-202", [[51.378, 35.683], [51.3825, 35.683]]),
      ],
    },
    { toleranceMeters: 0.025 },
  );

  assert.equal(result.undershoots.length, 1);
  assert.equal(result.overshoots.length, 1);
  const undershoot = result.undershoots[0]!;
  assert.equal(undershoot.featureId, "R-201");
  assert.equal(undershoot.relatedFeatureId, "P-101");
  assert.equal(undershoot.relatedTargetKind, "PolygonBoundary");
  assert.equal(undershoot.detectionMode, "DirectionalBoundaryPattern");
  assert.ok(undershoot.distanceMeters > 27 && undershoot.distanceMeters < 28);
  assert.equal(undershoot.repairable, true);
  const overshoot = result.overshoots[0]!;
  assert.equal(overshoot.featureId, "R-202");
  assert.equal(overshoot.relatedFeatureId, "P-103");
  assert.equal(overshoot.relatedTargetKind, "PolygonBoundary");
  assert.ok(
    overshoot.overrunDistanceMeters > 45 &&
      overshoot.overrunDistanceMeters < 46,
  );
  assert.equal(overshoot.repairable, true);
});

test("keeps inferred polygon-boundary repairs manual when target locations compete", () => {
  const boundary = {
    type: "Feature",
    id: "narrow-boundary",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [0.001, -0.001],
        [0.0010001, -0.001],
        [0.0010001, 0.001],
        [0.001, 0.001],
        [0.001, -0.001],
      ]],
    },
  };
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        boundary,
        line("ambiguous-undershoot", [[-0.01, 0], [0.0008, 0]]),
        line("ambiguous-overshoot", [
          [-0.01, 0.0005],
          [0.0012, 0.0005],
        ]),
      ],
    },
    { toleranceMeters: 0.025 },
  );

  const undershoot = result.undershoots.find(
    (finding) => finding.featureId === "ambiguous-undershoot",
  );
  const overshoot = result.overshoots.find(
    (finding) => finding.featureId === "ambiguous-overshoot",
  );
  assert.ok(undershoot);
  assert.equal(undershoot.detectionMode, "DirectionalBoundaryPattern");
  assert.equal(undershoot.repairable, false);
  assert.ok(overshoot);
  assert.equal(overshoot.detectionMode, "DirectionalBoundaryPattern");
  assert.equal(overshoot.repairable, false);
});

test("treats coincident polygon boundary targets as one inferred location", () => {
  const polygon = (id: string, minimumX: number, maximumX: number) => ({
    type: "Feature",
    id,
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [minimumX, -0.001],
        [maximumX, -0.001],
        [maximumX, 0.001],
        [minimumX, 0.001],
        [minimumX, -0.001],
      ]],
    },
  });
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        polygon("left", -0.002, 0.001),
        polygon("right", 0.001, 0.003),
        line("shared-boundary-undershoot", [[-0.01, 0], [0.0008, 0]]),
      ],
    },
    { toleranceMeters: 0.025 },
  );

  const finding = result.undershoots.find(
    (candidate) => candidate.featureId === "shared-boundary-undershoot",
  );
  assert.ok(finding);
  assert.deepEqual(finding.targetPosition, [0.001, 0]);
  assert.equal(finding.detectionMode, "DirectionalBoundaryPattern");
  assert.equal(finding.repairable, true);
});

test("keeps an inferred boundary extension manual across an intervening line", () => {
  const boundary = {
    type: "Feature",
    id: "boundary",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [0.001, -0.001],
        [0.003, -0.001],
        [0.003, 0.001],
        [0.001, 0.001],
        [0.001, -0.001],
      ]],
    },
  };
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        boundary,
        line("source", [[-0.01, 0], [0.0008, 0]]),
        line("intervening", [[0.0009, -0.001], [0.0009, 0.001]]),
      ],
    },
    { toleranceMeters: 0.025 },
  );

  const finding = result.undershoots.find(
    (candidate) => candidate.featureId === "source",
  );
  assert.ok(finding);
  assert.equal(finding.relatedFeatureId, "boundary");
  assert.equal(finding.detectionMode, "DirectionalBoundaryPattern");
  assert.equal(finding.repairable, false);
});

test("does not classify a crossing at the opposite endpoint as repairable overshoot", () => {
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        line("short", [[0.001, 0], [0.0010002, 0]]),
        line("target", [[0.001, -0.001], [0.001, 0.001]]),
      ],
    },
    { toleranceMeters: 0.03 },
  );

  assert.deepEqual(result.overshoots, []);
});

test("deduplicates a disconnected endpoint-to-endpoint relationship", () => {
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        line("first", [[0, 0], [0.001, 0]]),
        line("second", [[0.0010002, 0], [0.002, 0]]),
      ],
    },
    { toleranceMeters: 0.03 },
  );

  assert.equal(result.undershoots.length, 1);
  assert.equal(result.overshoots.length, 0);
});

test("reports nested geometry and multiline coordinate paths", () => {
  const result = detectLineTopology(
    {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "collection",
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [
              {
                type: "MultiLineString",
                coordinates: [[[0, 0], [0.0009998, 0]]],
              },
            ],
          },
        },
        line("target", [[0.001, -0.001], [0.001, 0.001]]),
      ],
    },
    { toleranceMeters: 0.03 },
  );

  const issue = result.undershoots[0]!;
  assert.deepEqual(issue.geometryCollectionPath, [0]);
  assert.deepEqual(issue.coordinateRootPath, [0]);
  assert.deepEqual(issue.coordinatePath, [0, 1]);
});

test("rejects invalid line topology tolerances", () => {
  assert.throws(
    () =>
      detectLineTopology(
        { type: "FeatureCollection", features: [] },
        { toleranceMeters: Number.POSITIVE_INFINITY },
      ),
    /finite non-negative/,
  );
});
