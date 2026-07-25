import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calculateRingOrientation } from "../ring-orientation";
import {
  detectInvalidHoles,
  processInvalidHoles,
  repairInvalidHoles,
} from "./index";

test("processes the GEO-005 integration dataset conservatively", () => {
  const fixturePath = path.resolve(
    process.cwd(),
    "src/test-data/geojson/geo-005-invalid-holes.geojson",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  const result = processInvalidHoles(fixture, { tinyHoleAreaM2: 1 });

  assert.deepEqual(
    {
      scanned: result.report.holesScanned,
      invalid: result.report.invalidHolesFound,
      removed: result.report.holesRemoved,
      outsideRemoved: result.report.outsideHolesRemoved,
      tinyRemoved: result.report.tinyHolesRemoved,
      normalized: result.report.holeOrientationsNormalized,
      outside: result.report.outsideHoles,
      nested: result.report.nestedHoles,
      duplicate: result.report.duplicateHoles,
      selfIntersecting: result.report.selfIntersectingHoles,
      touching: result.report.touchingBoundaryHoles,
      tiny: result.report.tinyHoles,
      larger: result.report.holesLargerThanPolygon,
      unresolved: result.report.unresolvedIssues,
      quarantine: result.report.unresolvedFeatureIndexes,
    },
    {
      scanned: 10,
      invalid: 7,
      removed: 3,
      outsideRemoved: 2,
      tinyRemoved: 1,
      normalized: 1,
      outside: 2,
      nested: 1,
      duplicate: 1,
      selfIntersecting: 1,
      touching: 1,
      tiny: 1,
      larger: 1,
      unresolved: 4,
      quarantine: [1, 2, 3, 4],
    },
  );

  assert.equal(result.geojson.features[0].geometry.coordinates.length, 1);
  assert.equal(result.geojson.features[5].geometry.coordinates.length, 1);
  assert.equal(result.geojson.features[6].geometry.coordinates.length, 1);
  assert.equal(
    calculateRingOrientation(
      result.geojson.features[7].geometry.coordinates[1],
    ),
    "clockwise",
  );
  assert.equal(fixture.features[0].geometry.coordinates.length, 2);
  assert.equal(fixture.features[5].geometry.coordinates.length, 2);
});

test("does not remove or normalize holes when auto repair is disabled", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
            [
              [12, 12],
              [14, 12],
              [14, 14],
              [12, 14],
              [12, 12],
            ],
          ],
        },
      },
    ],
  };

  const result = processInvalidHoles(
    input,
    { tinyHoleAreaM2: 0 },
    false,
  );

  assert.equal(result.report.holesRemoved, 0);
  assert.equal(result.report.unresolvedIssues, 1);
  assert.equal(result.geojson, input);
});

test("repairs MultiPolygon holes inside a nested geometry collection", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "MultiPolygon",
              coordinates: [
                [
                  [
                    [0, 0],
                    [10, 0],
                    [10, 10],
                    [0, 10],
                    [0, 0],
                  ],
                  [
                    [12, 12],
                    [12, 13],
                    [13, 13],
                    [13, 12],
                    [12, 12],
                  ],
                ],
                [
                  [
                    [20, 0],
                    [30, 0],
                    [30, 10],
                    [20, 10],
                    [20, 0],
                  ],
                  [
                    [22, 2],
                    [24, 2],
                    [24, 4],
                    [22, 4],
                    [22, 2],
                  ],
                ],
              ],
            },
          ],
        },
      },
    ],
  };

  const result = processInvalidHoles(input, { tinyHoleAreaM2: 0 });
  const multiPolygon =
    result.geojson.features[0]!.geometry.geometries[0]!;

  assert.equal(result.report.holesScanned, 2);
  assert.equal(result.report.holesRemoved, 1);
  assert.equal(result.report.holeOrientationsNormalized, 1);
  assert.equal(multiPolygon.coordinates[0]!.length, 1);
  assert.equal(
    calculateRingOrientation(multiPolygon.coordinates[1]![1]!),
    "clockwise",
  );
  assert.deepEqual(result.report.issues[0]?.geometryCollectionPath, [0]);
  assert.deepEqual(result.report.issues[0]?.coordinatePath, [0, 1]);
});

test("the removal boundary rejects a stale hole target", () => {
  const original = {
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
            [
              [12, 12],
              [12, 14],
              [14, 14],
              [14, 12],
              [12, 12],
            ],
          ],
        },
      },
    ],
  };
  const detection = detectInvalidHoles(original, {
    tinyHoleAreaM2: 0,
  });
  const changed = structuredClone(original);
  changed.features[0]!.geometry.coordinates[1] = [
    [2, 2],
    [2, 4],
    [4, 4],
    [4, 2],
    [2, 2],
  ];

  const repair = repairInvalidHoles(changed, detection.findings);

  assert.equal(repair.removedHoleKeys.size, 0);
  assert.equal(
    repair.geojson.features[0]!.geometry.coordinates.length,
    2,
  );
});
