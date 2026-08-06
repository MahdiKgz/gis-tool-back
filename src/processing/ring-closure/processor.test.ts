import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processRingClosure } from "./index";
import { closeRingTargets } from "./repair";

test("closes a ring with an exact copy of its multidimensional first position", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0, 12],
              [2, 0, 12],
              [1, 2, 12],
            ],
          ],
        },
      },
    ],
  };

  const result = processRingClosure(input);
  const outputRing = result.geojson.features[0]?.geometry?.coordinates as
    | number[][][]
    | undefined;

  assert.equal(result.report.openRingsFound, 1);
  assert.equal(result.report.ringsClosed, 1);
  assert.equal(result.report.unresolvedOpenRings, 0);
  assert.deepEqual(outputRing?.[0]?.at(-1), [0, 0, 12]);
  assert.notEqual(outputRing?.[0]?.at(-1), outputRing?.[0]?.[0]);
  assert.equal(
    (input.features[0]?.geometry.coordinates as number[][][])[0]?.length,
    3,
  );
});

test("processes the GEO-003 integration dataset", () => {
  const fixturePath = path.resolve(
    process.cwd(),
    "src/test-data/geojson/geo-003-ring-closure.geojson",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  const result = processRingClosure(fixture);

  assert.deepEqual(
    {
      scanned: result.report.ringsScanned,
      open: result.report.openRingsFound,
      closed: result.report.ringsClosed,
      unresolved: result.report.unresolvedOpenRings,
      unresolvedFeatures: result.report.unresolvedFeatureIndexes,
    },
    {
      scanned: 6,
      open: 5,
      closed: 3,
      unresolved: 2,
      unresolvedFeatures: [2, 3],
    },
  );

  assert.equal(
    result.geojson.features[0].geometry.coordinates[0].length,
    5,
  );
  assert.equal(
    result.geojson.features[1].geometry.coordinates[0][1].length,
    4,
  );
  assert.equal(
    result.geojson.features[4].geometry.geometries[0].coordinates[0].length,
    4,
  );
  assert.equal(
    result.geojson.features[2].geometry.coordinates[0].length,
    4,
  );
});

test("reports repairable rings as unresolved when auto repair is disabled", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [1, 2],
            ],
          ],
        },
      },
    ],
  };

  const result = processRingClosure(input, false);

  assert.equal(result.report.openRingsFound, 1);
  assert.equal(result.report.ringsClosed, 0);
  assert.equal(result.report.unresolvedOpenRings, 1);
  assert.equal(result.report.valid, false);
  assert.equal(
    (result.geojson.features[0]?.geometry?.coordinates as number[][][])[0]
      ?.length,
    3,
  );
});

test("the repair boundary rejects unsafe targets defensively", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              null,
              [1, 1],
            ],
          ],
        },
      },
    ],
  };

  const result = closeRingTargets(input, [
    {
      featureIndex: 0,
      geometryCollectionPath: [],
      coordinatePath: [0],
    },
  ]);

  assert.equal(result.closedRingKeys.size, 0);
  assert.deepEqual(result.geojson, input);
});
