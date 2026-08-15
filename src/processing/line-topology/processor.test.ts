import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processLineTopology } from "./index";

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
