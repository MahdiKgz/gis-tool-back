import assert from "node:assert/strict";
import test from "node:test";
import area from "@turf/area";
import { processNeighborConsistency } from ".";
import { repairNeighborInconsistencies } from "./repair";
import type { FeatureCollectionLike } from "./types";

const input = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "west",
      properties: { layer: "parcels" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 0.5],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: "east",
      properties: { layer: "parcels" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1, 0],
            [2, 0],
            [2, 1],
            [1, 1],
            [1, 0],
          ],
        ],
      },
    },
  ],
} satisfies FeatureCollectionLike;

test("dry-run reports a safe neighbor repair without mutating input", () => {
  const before = structuredClone(input);
  const result = processNeighborConsistency(input);

  assert.equal(result.report.valid, false);
  assert.equal(result.report.mismatchesFound, 1);
  assert.equal(result.report.verticesInserted, 0);
  assert.equal(result.report.issues[0]?.recommendedAction, "AutoRepair");
  assert.deepEqual(result.geojson, input);
  assert.deepEqual(input, before);
});

test("inserts the missing vertex without changing polygon area", () => {
  const before = structuredClone(input);
  const areaBefore = input.features.map((item) => area(item as any));
  const result = processNeighborConsistency(input, {}, true);

  assert.equal(result.report.valid, true);
  assert.equal(result.report.verticesInserted, 1);
  assert.equal(result.report.unresolvedIssues, 0);
  assert.deepEqual(
    (result.geojson.features[1]!.geometry.coordinates[0] as number[][]),
    [
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 0.5],
      [1, 0],
    ],
  );
  assert.deepEqual(
    result.geojson.features.map((item) => area(item as any)),
    areaBefore,
  );
  assert.equal(
    processNeighborConsistency(result.geojson).report.mismatchesFound,
    0,
  );
  assert.deepEqual(input, before);
});

test("refuses a stale target instead of applying a misplaced insertion", () => {
  const detection = processNeighborConsistency(input);
  const changed = structuredClone(input) as any;
  changed.features[1].geometry.coordinates[0][3] = [1, 1.1];
  const repair = repairNeighborInconsistencies(
    changed,
    detection.report.issues,
  );

  assert.equal(repair.repairedKeys.size, 0);
  assert.deepEqual(
    [...repair.failedReasons.values()],
    ["StaleTarget"],
  );
});

test("refuses a repair when the source vertex no longer matches detection", () => {
  const detection = processNeighborConsistency(input);
  const changed = structuredClone(input) as any;
  changed.features[0].geometry.coordinates[0][2] = [1, 0.6];
  const repair = repairNeighborInconsistencies(
    changed,
    detection.report.issues,
  );

  assert.equal(repair.repairedKeys.size, 0);
  assert.deepEqual([...repair.failedReasons.values()], ["StaleTarget"]);
});

test("interpolates target ordinates instead of copying unrelated source elevation", () => {
  const threeDimensional = structuredClone(input) as any;
  threeDimensional.features[0].geometry.coordinates[0] = [
    [0, 0, 100],
    [1, 0, 100],
    [1, 0.5, 100],
    [1, 1, 100],
    [0, 1, 100],
    [0, 0, 100],
  ];
  threeDimensional.features[1].geometry.coordinates[0] = [
    [1, 0, 10],
    [2, 0, 10],
    [2, 1, 20],
    [1, 1, 20],
    [1, 0, 10],
  ];

  const result = processNeighborConsistency(threeDimensional, {}, true);

  assert.equal(result.report.verticesInserted, 1);
  assert.deepEqual(
    result.geojson.features[1].geometry.coordinates[0][4],
    [1, 0.5, 15],
  );
});
