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

test("repairs a uniquely matched long cadastral gap using relative width evidence", () => {
  const square = (x: number, id: string) => ({
    type: "Feature",
    id,
    properties: { parcel: id },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [x, 35.68],
        [x + 0.002, 35.68],
        [x + 0.002, 35.682],
        [x, 35.682],
        [x, 35.68],
      ]],
    },
  });
  const fixture = {
    type: "FeatureCollection",
    features: [square(51.38, "west"), square(51.3822, "east")],
  };
  const before = structuredClone(fixture);
  const result = processGaps(
    fixture,
    { gapToleranceMeters: 0.075 },
    true,
  );

  assert.equal(result.report.gapsFound, 1);
  assert.equal(result.report.gapsRepaired, 1);
  assert.equal(result.report.unresolvedIssues, 0);
  const westEdge = result.geojson.features[0]!.geometry.coordinates[0]!;
  const eastEdge = result.geojson.features[1]!.geometry.coordinates[0]!;
  assert.deepEqual(westEdge[1], eastEdge[0]);
  assert.deepEqual(westEdge[2], eastEdge[3]);
  assert.deepEqual(fixture, before);
});

test("rolls back an inferred gap repair that would overlap a third parcel", () => {
  const polygonFeature = (id: string, coordinates: number[][]) => ({
    type: "Feature",
    id,
    properties: {},
    geometry: { type: "Polygon", coordinates: [coordinates] },
  });
  const west = polygonFeature("west", [
    [51.38, 35.68],
    [51.382, 35.68],
    [51.382, 35.682],
    [51.38, 35.682],
    [51.38, 35.68],
  ]);
  const east = polygonFeature("east", [
    [51.3822, 35.68],
    [51.3842, 35.68],
    [51.3842, 35.682],
    [51.3822, 35.682],
    [51.3822, 35.68],
  ]);
  const road = polygonFeature("road", [
    [51.38199, 35.6805],
    [51.38221, 35.6805],
    [51.38221, 35.6815],
    [51.38199, 35.6815],
    [51.38199, 35.6805],
  ]);
  const fixture = {
    type: "FeatureCollection",
    features: [west, east, road],
  };
  const dryRun = processGaps(
    fixture,
    { gapToleranceMeters: 0.075 },
    false,
  );
  const dryRunFinding = dryRun.report.issues.find(
    (issue) => issue.featureId === "west" && issue.relatedFeatureId === "east",
  );
  assert.equal(dryRun.geojson, fixture);
  assert.equal(dryRunFinding?.recommendedAction, "ManualReview");
  assert.equal(dryRunFinding?.repairFailureReason, "WouldCreateOverlap");

  const result = processGaps(
    fixture,
    { gapToleranceMeters: 0.075 },
    true,
  );

  const inferredFinding = result.report.issues.find(
    (issue) => issue.featureId === "west" && issue.relatedFeatureId === "east",
  );
  assert.equal(inferredFinding?.status, "Unresolved");
  assert.equal(inferredFinding?.recommendedAction, "ManualReview");
  assert.equal(inferredFinding?.repairFailureReason, "WouldCreateOverlap");
  assert.equal(result.report.gapsRepaired, 0);
  assert.equal(result.geojson, fixture);
});
