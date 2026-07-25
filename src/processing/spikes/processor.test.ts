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
  assert.equal(result.geojson, input);
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
  assert.equal(
    result.geojson.features[0]!.geometry.coordinates.length,
    3,
  );
});
