import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processDuplicateVertices } from "../duplicate-vertices";
import { processInvalidRings } from "./index";

test("repairs safe rings without mutating input coordinates", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "open triangle" },
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

  const result = processInvalidRings(input);

  assert.equal(result.report.invalidRingsFound, 1);
  assert.equal(result.report.ringsRepaired, 1);
  assert.equal(result.report.unresolvedIssues, 0);
  assert.equal(result.report.valid, true);
  assert.deepEqual(result.geojson.features[0]?.geometry?.coordinates, [
    [
      [0, 0],
      [2, 0],
      [1, 2],
      [0, 0],
    ],
  ]);
  assert.equal(
    (input.features[0]?.geometry.coordinates as number[][][])[0]?.length,
    3,
  );
});

test("processes the GEO-002 integration dataset and identifies quarantine indexes", () => {
  const fixturePath = path.resolve(
    process.cwd(),
    "src/test-data/geojson/geo-002-invalid-rings.geojson",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  const result = processInvalidRings(fixture);

  assert.deepEqual(
    {
      scanned: result.report.ringsScanned,
      invalid: result.report.invalidRingsFound,
      repaired: result.report.ringsRepaired,
      unclosed: result.report.unclosedRings,
      corrupted: result.report.corruptedRings,
      insufficient: result.report.insufficientRings,
      unresolved: result.report.unresolvedIssues,
      quarantine: result.report.unresolvedFeatureIndexes,
    },
    {
      scanned: 5,
      invalid: 4,
      repaired: 2,
      unclosed: 2,
      corrupted: 1,
      insufficient: 1,
      unresolved: 2,
      quarantine: [1, 2],
    },
  );

  assert.equal(
    result.geojson.features[0].geometry.coordinates[0].length,
    5,
  );
  assert.equal(
    result.geojson.features[3].geometry.geometries[0].coordinates[0].length,
    4,
  );
});

test("ring closure enables duplicate-vertex repair without collapsing the ring", () => {
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
              [2, 0],
              [1, 2],
            ],
          ],
        },
      },
    ],
  };

  const ringResult = processInvalidRings(input);
  const duplicateResult = processDuplicateVertices(ringResult.geojson);

  assert.equal(ringResult.report.ringsRepaired, 1);
  assert.equal(duplicateResult.report.duplicatesRemoved, 1);
  assert.deepEqual(
    duplicateResult.geojson.features[0]?.geometry?.coordinates,
    [
      [
        [0, 0],
        [2, 0],
        [1, 2],
        [0, 0],
      ],
    ],
  );
});
