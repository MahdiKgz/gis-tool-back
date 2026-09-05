import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildSelfIntersectionReport,
  detectSelfIntersections,
  processSelfIntersections,
  repairSelfIntersections,
} from "./index";

test("repairs an isolated crossing as one MultiPolygon feature", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/dry-run-self-intersections.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);

  const result = processSelfIntersections(fixture);

  assert.notEqual(result.geojson, fixture);
  assert.deepEqual(fixture, before);
  assert.equal(result.report.valid, false);
  assert.equal(result.report.selfIntersectionsFound, 2);
  assert.equal(result.report.crossingsFound, 2);
  assert.equal(result.report.selfIntersectionsRepaired, 1);
  assert.equal(result.report.unresolvedIssues, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [2]);
  assert.equal(result.report.issues[0]?.status, "Repaired");
  assert.equal(result.report.issues[0]?.recommendedAction, "None");
  assert.equal(result.report.issues[1]?.status, "Unresolved");
  assert.equal(result.report.issues[1]?.recommendedAction, "ManualReview");
  assert.equal(result.geojson.features[1]?.id, "bow-tie");
  assert.deepEqual(result.geojson.features[1]?.properties, {});
  assert.equal(result.geojson.features[1]?.geometry.type, "MultiPolygon");
  assert.equal(
    (result.geojson.features[1]?.geometry.coordinates as unknown[]).length,
    2,
  );
  assert.deepEqual(
    result.report.issues.map((issue) => ({
      featureId: issue.featureId,
      geometryCollectionPath: issue.geometryCollectionPath,
      polygonPath: issue.polygonPath,
      coordinatePath: issue.coordinatePath,
    })),
    [
      {
        featureId: "bow-tie",
        geometryCollectionPath: [],
        polygonPath: [],
        coordinatePath: [0, 0],
      },
      {
        featureId: "nested-multipolygon",
        geometryCollectionPath: [0],
        polygonPath: [1],
        coordinatePath: [1, 0, 0],
      },
    ],
  );
});

test("dry-run reports isolated crossing auto-repair without mutating input", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "bow-tie",
        properties: { parcel: "A-1" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0, 0],
            [2, 2],
            [0, 2],
            [2, 0],
            [0, 0],
          ]],
        },
      },
    ],
  };

  const result = processSelfIntersections(input, false);

  assert.equal(result.geojson, input);
  assert.equal(result.report.selfIntersectionsFound, 1);
  assert.equal(result.report.selfIntersectionsRepaired, 0);
  assert.equal(result.report.unresolvedIssues, 1);
  assert.equal(result.report.issues[0]?.repairable, true);
  assert.equal(result.report.issues[0]?.recommendedAction, "AutoRepair");
});

test("repairs one isolated MultiPolygon component without splitting feature identity", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "multipart-bow-tie",
        properties: { owner: "same-owner" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[
              [0, 0],
              [2, 2],
              [0, 2],
              [2, 0],
              [0, 0],
            ]],
            [[
              [10, 10],
              [12, 10],
              [12, 12],
              [10, 12],
              [10, 10],
            ]],
          ],
        },
      },
    ],
  };

  const result = processSelfIntersections(input);

  assert.equal(result.report.selfIntersectionsRepaired, 1);
  assert.equal(result.report.unresolvedIssues, 0);
  assert.equal(result.geojson.features.length, 1);
  assert.equal(result.geojson.features[0]?.id, "multipart-bow-tie");
  assert.deepEqual(result.geojson.features[0]?.properties, {
    owner: "same-owner",
  });
  assert.equal(
    (result.geojson.features[0]?.geometry.coordinates as unknown[]).length,
    3,
  );
});

test("keeps touching and overlapping self-intersections manual", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        id: "touch",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0, 0],
            [2, 0],
            [1, 1],
            [1, 0],
            [0, 2],
            [0, 0],
          ]],
        },
      },
      {
        id: "overlap",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [10, 0],
            [14, 0],
            [14, 4],
            [11, 0],
            [13, 0],
            [10, 4],
            [10, 0],
          ]],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const result = processSelfIntersections(input);

  assert.equal(result.report.selfIntersectionsRepaired, 0);
  assert.ok(result.report.touchesFound >= 1);
  assert.ok(result.report.overlapsFound >= 1);
  assert.ok(
    result.report.issues.every(
      (issue) =>
        issue.repairable === false &&
        issue.recommendedAction === "ManualReview",
    ),
  );
  assert.deepEqual(result.geojson, before);
});

test("rejects a stale isolated crossing repair target", () => {
  const original = {
    type: "FeatureCollection",
    features: [
      {
        id: "bow-tie",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0, 0],
            [2, 2],
            [0, 2],
            [2, 0],
            [0, 0],
          ]],
        },
      },
    ],
  };
  const detection = detectSelfIntersections(original);
  const changed = structuredClone(original);
  changed.features[0]!.geometry.coordinates[0]![1]![0] = 99;

  const result = repairSelfIntersections(changed, detection.findings);
  const report = buildSelfIntersectionReport(
    detection,
    result.repairedKeys,
    result.failedReasons,
  );

  assert.equal(result.repairedKeys.size, 0);
  assert.equal(result.failedReasons.values().next().value, "StaleTarget");
  assert.equal(report.issues[0]?.recommendedAction, "ManualReview");
  assert.equal(report.issues[0]?.repairFailureReason, "StaleTarget");
  assert.equal(result.geojson, changed);
});
