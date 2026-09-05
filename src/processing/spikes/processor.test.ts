import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calculateRingOrientation } from "../ring-orientation";
import { detectSpikes, processSpikes, repairSpikes } from "./index";

test("processes the GEO-006 fixture without mutating input", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/test-data/geojson/geo-006-spikes.geojson",
      ),
      "utf8",
    ),
  );

  const result = processSpikes(fixture, {
    baseToleranceMeters: 0.02,
  });

  assert.equal(result.report.spikesFound, 2);
  assert.equal(result.report.spikesRemoved, 2);
  assert.equal(result.report.unresolvedSpikes, 0);
  assert.equal(
    result.geojson.features[0].geometry.coordinates.length,
    3,
  );
  assert.equal(
    result.geojson.features[1].geometry.coordinates[0].length,
    6,
  );
  assert.equal(
    calculateRingOrientation(
      result.geojson.features[1].geometry.coordinates[0],
    ),
    "counterclockwise",
  );
  assert.equal(fixture.features[0].geometry.coordinates.length, 4);
  assert.equal(fixture.features[1].geometry.coordinates[0].length, 7);
});

test("does not repair spikes when auto repair is disabled", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.001, 0.001],
            [0.0000001, 0],
          ],
        },
      },
    ],
  };

  const result = processSpikes(
    input,
    { baseToleranceMeters: 0.02 },
    false,
  );

  assert.equal(result.report.spikesRemoved, 0);
  assert.equal(result.report.unresolvedSpikes, 1);
  assert.equal(
    result.report.issues[0]?.recommendedAction,
    "AutoRepair",
  );
  assert.equal(result.geojson, input);
});

test("removes a strongly evidenced ring spike beyond base tolerance", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        id: "cadastral-spike",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [51.3875, 35.68],
            [51.3895, 35.68],
            [51.3895, 35.682],
            [51.39, 35.6845],
            [51.3894, 35.682],
            [51.3875, 35.682],
            [51.3875, 35.68],
          ]],
        },
      },
    ],
  };

  const result = processSpikes(input, { baseToleranceMeters: 0.025 });

  assert.equal(result.report.spikesFound, 1);
  assert.equal(result.report.spikesRemoved, 1);
  assert.equal(result.report.unresolvedSpikes, 0);
  assert.equal(result.report.issues[0]?.repairEvidence, "StrongRingBacktrack");
  assert.equal(result.geojson.features[0]!.geometry.coordinates[0]!.length, 6);
  assert.equal(input.features[0]!.geometry.coordinates[0]!.length, 7);
});

test("rolls back a strong spike removal when the resulting ring stays invalid", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        id: "spike-with-crossing",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0, 0],
            [4, 4],
            [0, 4],
            [0.001, 10],
            [0.0001, 4],
            [4, 0],
            [0, 0],
          ]],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const result = processSpikes(input, { baseToleranceMeters: 0.025 });

  assert.ok(result.report.spikesFound >= 1);
  assert.equal(result.report.spikesRemoved, 0);
  assert.ok(
    result.report.issues.some(
      (issue) =>
        issue.repairable &&
        issue.recommendedAction === "ManualReview" &&
        issue.repairFailureReason === "InvalidRepairOutput",
    ),
  );
  assert.deepEqual(result.geojson, before);
});

test("rolls back an exterior spike repair that would strand a hole", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        id: "spike-owning-hole",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [6, 10],
              [5.99, 11],
              [5.98, 10],
              [0, 10],
              [0, 0],
            ],
            [
              [5.988, 10.04],
              [5.988, 10.06],
              [5.992, 10.06],
              [5.992, 10.04],
              [5.988, 10.04],
            ],
          ],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const result = processSpikes(input, { baseToleranceMeters: 1 });

  assert.equal(result.report.spikesFound, 1);
  assert.equal(result.report.issues[0]?.repairEvidence, "StrongRingBacktrack");
  assert.equal(result.report.spikesRemoved, 0);
  assert.equal(result.report.issues[0]?.recommendedAction, "ManualReview");
  assert.equal(
    result.report.issues[0]?.repairFailureReason,
    "InvalidRepairOutput",
  );
  assert.deepEqual(result.geojson, before);
});

test("the repair boundary rejects a stale spike target", () => {
  const original = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.001, 0.001],
            [0.0000001, 0],
          ],
        },
      },
    ],
  };
  const detection = detectSpikes(original, {
    baseToleranceMeters: 0.02,
  });
  const changed = structuredClone(original);
  changed.features[0]!.geometry.coordinates[1] = [0.5, 0.5];

  const result = repairSpikes(changed, detection.findings);

  assert.equal(result.removedKeys.size, 0);
  assert.ok([...result.failedReasons.values()].includes("StaleTarget"));
  assert.equal(
    result.geojson.features[0]!.geometry.coordinates.length,
    3,
  );
});
