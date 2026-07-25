import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processRingOrientation } from "./index";
import { calculateRingOrientation } from "./orientation";
import { normalizeRingOrientations } from "./repair";

test("normalizes winding without mutating coordinates or losing dimensions", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0, 10],
              [0, 4, 20],
              [4, 4, 30],
              [4, 0, 40],
              [0, 0, 10],
            ],
          ],
        },
      },
    ],
  };

  const result = processRingOrientation(input);
  const outputRing = (result.geojson.features[0]?.geometry?.coordinates as
    | number[][][]
    | undefined)?.[0];

  assert.equal(result.report.ringsNormalized, 1);
  assert.equal(calculateRingOrientation(outputRing), "counterclockwise");
  assert.deepEqual(outputRing?.[0], [0, 0, 10]);
  assert.deepEqual(outputRing?.at(-1), [0, 0, 10]);
  assert.notEqual(
    result.geojson.features[0]?.geometry?.coordinates,
    input.features[0]?.geometry.coordinates,
  );
  assert.equal(
    calculateRingOrientation(input.features[0]?.geometry.coordinates[0]),
    "clockwise",
  );

  const repeated = processRingOrientation(result.geojson);
  assert.equal(repeated.report.orientationIssuesFound, 0);
  assert.equal(repeated.report.ringsNormalized, 0);
});

test("processes the GEO-004 integration dataset", () => {
  const fixturePath = path.resolve(
    process.cwd(),
    "src/test-data/geojson/geo-004-ring-orientation.geojson",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  const result = processRingOrientation(fixture);

  assert.deepEqual(
    {
      scanned: result.report.ringsScanned,
      evaluated: result.report.ringsEvaluated,
      issues: result.report.orientationIssuesFound,
      exterior: result.report.exteriorOrientationIssues,
      interior: result.report.interiorOrientationIssues,
      indeterminate: result.report.indeterminateRings,
      normalized: result.report.ringsNormalized,
      unresolved: result.report.unresolvedIssues,
      unresolvedFeatures: result.report.unresolvedFeatureIndexes,
    },
    {
      scanned: 8,
      evaluated: 8,
      issues: 5,
      exterior: 3,
      interior: 2,
      indeterminate: 1,
      normalized: 4,
      unresolved: 1,
      unresolvedFeatures: [4],
    },
  );

  assert.equal(
    calculateRingOrientation(
      result.geojson.features[0].geometry.coordinates[0],
    ),
    "counterclockwise",
  );
  assert.equal(
    calculateRingOrientation(
      result.geojson.features[1].geometry.coordinates[1],
    ),
    "clockwise",
  );
  assert.equal(
    calculateRingOrientation(
      result.geojson.features[2].geometry.coordinates[0][0],
    ),
    "counterclockwise",
  );
  assert.equal(
    calculateRingOrientation(
      result.geojson.features[2].geometry.coordinates[0][1],
    ),
    "clockwise",
  );
});

test("leaves incorrect orientation unresolved when auto repair is disabled", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [0, 4],
              [4, 4],
              [4, 0],
              [0, 0],
            ],
          ],
        },
      },
    ],
  };

  const result = processRingOrientation(input, false);

  assert.equal(result.report.orientationIssuesFound, 1);
  assert.equal(result.report.ringsNormalized, 0);
  assert.equal(result.report.unresolvedIssues, 1);
  assert.equal(result.report.valid, false);
  assert.equal(
    calculateRingOrientation(
      result.geojson.features[0]?.geometry?.coordinates,
    ),
    "indeterminate",
  );
  assert.equal(
    calculateRingOrientation(
      (result.geojson.features[0]?.geometry?.coordinates as number[][][])[0],
    ),
    "clockwise",
  );
});

test("the normalization boundary rejects a stale open-ring target", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [0, 4],
              [4, 4],
              [4, 0],
            ],
          ],
        },
      },
    ],
  };

  const result = normalizeRingOrientations(input, [
    {
      code: "INCORRECT_RING_ORIENTATION",
      featureIndex: 0,
      featureId: null,
      geometryType: "Polygon",
      geometryCollectionPath: [],
      coordinatePath: [0],
      role: "exterior",
      actualOrientation: "clockwise",
      expectedOrientation: "counterclockwise",
      repairable: true,
    },
  ]);

  assert.equal(result.normalizedRingKeys.size, 0);
  assert.deepEqual(result.geojson, input);
});
