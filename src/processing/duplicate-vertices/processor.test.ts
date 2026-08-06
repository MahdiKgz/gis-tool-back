import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processDuplicateVertices } from "./index";

test("repairs nested safe duplicates and reports unsafe repeats", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "mixed" },
        geometry: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "LineString",
              coordinates: [
                [0, 0],
                [0, 0],
                [1, 1],
              ],
            },
            {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [2, 0],
                  [1, 2],
                  [0, 0],
                  [0, 0],
                ],
              ],
            },
            {
              type: "LineString",
              coordinates: [
                [3, 3],
                [4, 4],
                [3, 3],
              ],
            },
          ],
        },
      },
    ],
  };

  const result = processDuplicateVertices(input);

  assert.equal(result.report.duplicatesFound, 3);
  assert.equal(result.report.duplicatesRemoved, 2);
  assert.equal(result.report.unresolvedDuplicates, 1);
  assert.equal(result.report.valid, false);

  const geometries = result.geojson.features[0]?.geometry.geometries as any[];
  assert.deepEqual(geometries[0].coordinates, [
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(geometries[1].coordinates[0], [
    [0, 0],
    [2, 0],
    [1, 2],
    [0, 0],
  ]);
  assert.deepEqual(geometries[2].coordinates, [
    [3, 3],
    [4, 4],
    [3, 3],
  ]);

  assert.equal(
    (input.features[0]?.geometry.geometries as any[])[0].coordinates.length,
    3,
  );
  assert.equal(
    (input.features[0]?.geometry.geometries as any[])[1].coordinates[0].length,
    5,
  );
});

test("processes the GEO-001 integration dataset", () => {
  const fixturePath = path.resolve(
    process.cwd(),
    "src/test-data/geojson/geo-001-duplicate-vertices.geojson",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  const result = processDuplicateVertices(fixture);

  assert.deepEqual(
    {
      found: result.report.duplicatesFound,
      removed: result.report.duplicatesRemoved,
      unresolved: result.report.unresolvedDuplicates,
      consecutive: result.report.consecutiveDuplicates,
      nonConsecutive: result.report.nonConsecutiveDuplicates,
    },
    {
      found: 4,
      removed: 2,
      unresolved: 2,
      consecutive: 3,
      nonConsecutive: 1,
    },
  );

  assert.equal(
    result.geojson.features[0].geometry.coordinates[0].length,
    5,
  );
  assert.equal(
    result.geojson.features[1].geometry.coordinates[0].length,
    2,
  );
});
