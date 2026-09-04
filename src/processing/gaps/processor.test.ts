import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { prepareOutputCoordinates } from "../coordinate-precision";
import { processGaps } from "./index";

test("reports the combined topology fixture without changing polygons", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processGaps(fixture, { gapToleranceMeters: 0.09 });

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.gapsFound, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [0, 1]);
  assert.deepEqual(fixture, before);
});

test("repairs a 50 mm-scale cadastral gap by creating one shared edge", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve("src/test-data/geojson/gap-healing-50mm.geojson"),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processGaps(
    fixture,
    { gapToleranceMeters: 0.15, minimumGapWidthMeters: 0.05 },
    true,
  );

  assert.equal(result.report.gapsFound, 1);
  assert.equal(result.report.gapsRepaired, 1);
  assert.equal(result.report.unresolvedIssues, 0);
  assert.equal(result.report.issues[0]?.status, "Repaired");
  assert.notEqual(result.geojson, fixture);
  assert.deepEqual(fixture, before);

  assert.deepEqual(result.geojson.features[0], fixture.features[0]);
  const west = result.geojson.features[1].geometry.coordinates[0];
  const east = result.geojson.features[2].geometry.coordinates[0];
  assert.deepEqual(west[1], east[0]);
  assert.deepEqual(west[2], east[3]);
  const roundedOutput = prepareOutputCoordinates(result.geojson, 9);
  assert.equal(
    processGaps(roundedOutput, {
      gapToleranceMeters: 0.15,
      minimumGapWidthMeters: 0.05,
    }).report.gapsFound,
    0,
  );
});

test("does not stretch partially aligned edges to force a repair", () => {
  const square = (x: number, y: number, id: string) => ({
    type: "Feature",
    id,
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [x, y],
        [x + 0.001, y],
        [x + 0.001, y + 0.001],
        [x, y + 0.001],
        [x, y],
      ]],
    },
  });
  const fixture = {
    type: "FeatureCollection",
    features: [
      square(0, 0, "west"),
      square(0.0010005, 0.0002, "offset-east"),
    ],
  };
  const result = processGaps(
    fixture,
    { gapToleranceMeters: 0.09 },
    true,
  );

  assert.equal(result.report.gapsFound, 1);
  assert.equal(result.report.gapsRepaired, 0);
  assert.equal(result.report.issues[0]?.recommendedAction, "ManualReview");
  assert.equal(result.geojson, fixture);
});
