import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  detectLineTopology,
  processLineTopology,
  processLineTopologyWithPolygonContext,
  repairLineTopology,
} from "./index";

test("repairs undershoots and overshoots without mutating input", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "undershoot",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0, 0, 3], [0.0009998, 0, 4]],
        },
      },
      {
        type: "Feature",
        id: "undershoot-target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.001, -0.001], [0.001, 0.001]],
        },
      },
      {
        type: "Feature",
        id: "overshoot",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.01, 0, 8], [0.0110002, 0, 9]],
        },
      },
      {
        type: "Feature",
        id: "overshoot-target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.011, -0.001], [0.011, 0.001]],
        },
      },
    ],
  };
  const before = structuredClone(input);
  const result = processLineTopology(input, { toleranceMeters: 0.03 });

  assert.deepEqual(input, before);
  assert.deepEqual(
    result.geojson.features?.[0]?.geometry?.coordinates,
    [[0, 0, 3], [0.001, 0, 4]],
  );
  assert.deepEqual(
    result.geojson.features?.[2]?.geometry?.coordinates,
    [[0.01, 0, 8], [0.011, 0, 9]],
  );
  assert.equal(result.reports.undershoots.undershootsRepaired, 1);
  assert.equal(result.reports.overshoots.overshootsRepaired, 1);
  assert.equal(result.reports.undershoots.valid, true);
  assert.equal(result.reports.overshoots.valid, true);
});

test("dry-run mode reports auto repair without changing coordinates", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processLineTopology(
    fixture,
    { toleranceMeters: 0.03 },
    false,
  );

  assert.equal(result.geojson, fixture);
  assert.deepEqual(fixture, before);
  assert.equal(result.reports.undershoots.undershootsFound, 1);
  assert.equal(result.reports.overshoots.overshootsFound, 1);
  assert.equal(
    result.reports.undershoots.issues[0]?.recommendedAction,
    "AutoRepair",
  );
  assert.equal(result.reports.undershoots.valid, false);
  assert.equal(result.reports.overshoots.valid, false);
});

test("removes every terminal segment beyond an overshoot intersection", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "multi-segment-overshoot",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.0010002, 0],
            [0.0010003, 0.00000005],
          ],
        },
      },
      {
        type: "Feature",
        id: "target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.001, -0.001], [0.001, 0.001]],
        },
      },
    ],
  };
  const result = processLineTopology(input, { toleranceMeters: 0.05 });

  assert.equal(result.reports.overshoots.overshootsRepaired, 1);
  assert.equal(
    result.reports.overshoots.issues[0]?.sourceSegmentIndex,
    0,
  );
  assert.deepEqual(
    result.geojson.features?.[0]?.geometry?.coordinates,
    [[0, 0], [0.001, 0]],
  );
});

test("reports but does not apply an undershoot repair that would collapse a line", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "short",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.0009998, 0], [0.001, 0]],
        },
      },
      {
        type: "Feature",
        id: "target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.001, -0.001], [0.001, 0.001]],
        },
      },
    ],
  };
  const result = processLineTopology(input, { toleranceMeters: 0.03 });

  assert.equal(result.reports.undershoots.undershootsFound, 1);
  assert.equal(result.reports.undershoots.undershootsRepaired, 0);
  assert.equal(result.reports.undershoots.issues[0]?.repairable, false);
  assert.equal(
    result.reports.undershoots.issues[0]?.recommendedAction,
    "ManualReview",
  );
  assert.deepEqual(
    result.geojson.features?.[0]?.geometry,
    input.features[0]?.geometry,
  );
});

test("repairs directionally inferred polygon-boundary endpoints transactionally", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "boundary",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [51.38, 35.68],
            [51.382, 35.68],
            [51.382, 35.682],
            [51.38, 35.682],
            [51.38, 35.68],
          ]],
        },
      },
      {
        type: "Feature",
        id: "undershoot",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[51.378, 35.681], [51.3817, 35.681]],
        },
      },
      {
        type: "Feature",
        id: "overshoot",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[51.378, 35.6805], [51.3825, 35.6805]],
        },
      },
    ],
  };
  const result = processLineTopology(input, { toleranceMeters: 0.025 });

  assert.equal(result.reports.undershoots.undershootsRepaired, 1);
  assert.equal(result.reports.overshoots.overshootsRepaired, 1);
  assert.deepEqual(
    result.geojson.features?.[1]?.geometry?.coordinates,
    [[51.378, 35.681], [51.382, 35.681]],
  );
  assert.deepEqual(
    result.geojson.features?.[2]?.geometry?.coordinates,
    [[51.378, 35.6805], [51.382, 35.6805]],
  );
});

test("rejects an inferred extension that would create a self-intersection", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "boundary",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0.0005, -0.0001],
            [0.0015, -0.0001],
            [0.0015, -0.002],
            [0.0005, -0.002],
            [0.0005, -0.0001],
          ]],
        },
      },
      {
        type: "Feature",
        id: "would-self-intersect",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.002, 0],
            [0.002, 0.002],
            [0.001, 0.002],
            [0.001, 0.0002],
          ],
        },
      },
    ],
  };
  const before = structuredClone(input);
  const result = processLineTopology(input, { toleranceMeters: 0.025 });
  const issue = result.reports.undershoots.issues.find(
    (candidate) => candidate.featureId === "would-self-intersect",
  );

  assert.ok(issue);
  assert.equal(issue.repairable, true);
  assert.equal(issue.status, "Unresolved");
  assert.equal(issue.recommendedAction, "ManualReview");
  assert.equal(issue.repairFailureReason, "WouldCreateSelfIntersection");
  assert.deepEqual(result.geojson, before);
});

test("keeps polygon targets available while returning only healed lines", () => {
  const line = {
    type: "Feature",
    id: "road",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [[51.378, 35.681], [51.3817, 35.681]],
    },
  };
  const parcel = {
    type: "Feature",
    id: "parcel",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [51.38, 35.68],
        [51.382, 35.68],
        [51.382, 35.682],
        [51.38, 35.682],
        [51.38, 35.68],
      ]],
    },
  };

  const result = processLineTopologyWithPolygonContext(
    [line],
    [parcel],
    { toleranceMeters: 0.025 },
  );

  assert.equal(result.reports.undershoots.undershootsRepaired, 1);
  assert.equal(result.geojson.features?.length, 1);
  assert.equal(result.geojson.features?.[0]?.id, "road");
  assert.deepEqual(
    result.geojson.features?.[0]?.geometry?.coordinates,
    [[51.378, 35.681], [51.382, 35.681]],
  );
});

test("records a stale endpoint instead of claiming it can still auto-repair", () => {
  const original = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "short",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0, 0], [0.0009998, 0]],
        },
      },
      {
        type: "Feature",
        id: "target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.001, -0.001], [0.001, 0.001]],
        },
      },
    ],
  };
  const detection = detectLineTopology(original, { toleranceMeters: 0.03 });
  const changed = structuredClone(original);
  changed.features[0]!.geometry.coordinates[1] = [0.0005, 0];

  const repair = repairLineTopology(changed, detection.undershoots);

  assert.equal(repair.repairedKeys.size, 0);
  assert.ok([...repair.rejectedKeys.values()].includes("StaleTarget"));
  assert.deepEqual(repair.geojson.features?.[0]?.geometry, changed.features[0]?.geometry);
});

test("rejects a repair when its referenced target segment is stale", () => {
  const original = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "short",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0, 0], [0.0009998, 0]],
        },
      },
      {
        type: "Feature",
        id: "target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.001, -0.001], [0.001, 0.001]],
        },
      },
    ],
  };
  const detection = detectLineTopology(original, { toleranceMeters: 0.03 });
  const changed = structuredClone(original);
  changed.features[1]!.geometry.coordinates = [
    [0.002, -0.001],
    [0.002, 0.001],
  ];

  const repair = repairLineTopology(changed, detection.undershoots);

  assert.equal(repair.repairedKeys.size, 0);
  assert.ok([...repair.rejectedKeys.values()].includes("StaleTarget"));
  assert.equal(repair.geojson, changed);
});

test("rolls back an endpoint whose line target is trimmed in the same batch", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "dependent-undershoot",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0, 0.0008], [0.0009998, 0.0008]],
        },
      },
      {
        type: "Feature",
        id: "trimmed-target",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[0.001, -0.001], [0.001, 0.0010002]],
        },
      },
      {
        type: "Feature",
        id: "parcel-boundary",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0.00099, 0.0004],
            [0.00101, 0.0004],
            [0.00101, 0.0006],
            [0.00099, 0.0006],
            [0.00099, 0.0004],
          ]],
        },
      },
    ],
  };

  const result = processLineTopology(input, { toleranceMeters: 0.03 }, true);
  const dependentIssue = result.reports.undershoots.issues.find(
    (issue) => issue.featureId === "dependent-undershoot",
  );
  const targetIssue = result.reports.overshoots.issues.find(
    (issue) => issue.featureId === "trimmed-target",
  );

  assert.equal(dependentIssue?.status, "Unresolved");
  assert.equal(
    dependentIssue?.repairFailureReason,
    "TargetChangedDuringRepair",
  );
  assert.equal(targetIssue?.status, "Repaired");
  assert.deepEqual(
    result.geojson.features?.[0]?.geometry?.coordinates,
    input.features[0]!.geometry.coordinates,
  );
  const trimmedCoordinates = result.geojson.features?.[1]?.geometry?.coordinates;
  assert.deepEqual(trimmedCoordinates?.[0], [0.001, -0.001]);
  const trimmedEnd = trimmedCoordinates?.[1] as number[] | undefined;
  assert.ok(trimmedEnd);
  assert.equal(trimmedEnd[0], 0.001);
  assert.ok(Math.abs(trimmedEnd[1]! - 0.0006) < 1e-15);
});
