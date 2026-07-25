import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeGeoJson, analyzeGisFile } from "./dry-run.service";

test("returns a clean report for valid geometry without mutating it", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "point-1",
        properties: {},
        geometry: {
          type: "Point",
          coordinates: [51.4, 35.7],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const report = analyzeGeoJson(input, {
    toleranceMillimeters: 25,
  });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.valid, true);
  assert.equal(report.summary.featuresScanned, 1);
  assert.equal(report.summary.checksRun, 12);
  assert.equal(report.summary.issuesFound, 0);
  assert.deepEqual(input, before);
});

test("reports issue locations and auto-repair availability without repairing", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "parcel-7",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const report = analyzeGeoJson(input, {
    toleranceMillimeters: 25,
  });

  const openRing = report.issues.find(
    (issue) => issue.code === "OPEN_RING",
  );
  const duplicate = report.issues.find(
    (issue) => issue.code === "DUPLICATE_VERTEX",
  );
  assert.ok(openRing);
  assert.equal(openRing.featureIndex, 0);
  assert.equal(openRing.featureId, "parcel-7");
  assert.deepEqual(openRing.location.coordinatePath, [0]);
  assert.equal(openRing.disposition, "AutoRepairAvailable");
  assert.ok(duplicate);
  assert.deepEqual(duplicate.location.coordinatePath, [0, 2]);
  assert.deepEqual(report.affectedFeatureCollection, {
    type: "FeatureCollection",
    features: [
      {
        ...input.features[0],
        snapgisFeatureIndex: 0,
      },
    ],
  });
  assert.notEqual(
    report.affectedFeatureCollection.features[0]?.geometry,
    input.features[0]?.geometry,
  );
  assert.equal(report.checks.ringClosure?.valid, false);
  assert.deepEqual(input, before);
});

test("analyzing a file leaves its source bytes unchanged", async () => {
  const fixturePath = path.resolve(
    "src/test-data/geojson/geo-001-duplicate-vertices.geojson",
  );
  const before = fs.readFileSync(fixturePath);

  const report = await analyzeGisFile(
    fixturePath,
    "geo-001-duplicate-vertices.geojson",
    { toleranceMillimeters: 25 },
  );

  assert.ok(report.summary.issuesFound > 0);
  assert.deepEqual(fs.readFileSync(fixturePath), before);
});

test("stops safely after the root GeoJSON structure check fails", () => {
  const report = analyzeGeoJson(
    { type: "Polygon", coordinates: [] },
    { toleranceMillimeters: 25 },
  );

  assert.equal(report.valid, false);
  assert.equal(report.summary.checksRun, 1);
  assert.deepEqual(report.affectedFeatureCollection.features, []);
  assert.equal(report.checks.geometryTypes?.rootValid, false);
});
