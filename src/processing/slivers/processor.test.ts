import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { processSlivers } from "./index";

test("reports slivers from the combined topology fixture without mutation", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processSlivers(fixture, {
    sliverAreaThresholdM2: 0.09,
  });

  assert.equal(result.geojson, fixture);
  assert.equal(result.report.sliversFound, 1);
  assert.deepEqual(result.report.unresolvedFeatureIndexes, [2]);
  assert.equal(result.report.issues[0]?.recommendedAction, "AutoRepair");
  assert.deepEqual(fixture, before);
});

test("removes an area-threshold sliver during healing without mutating input", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
      ),
      "utf8",
    ),
  );
  const before = structuredClone(fixture);
  const result = processSlivers(
    fixture,
    { sliverAreaThresholdM2: 0.09 },
    true,
  );

  assert.equal(result.report.sliversFound, 1);
  assert.equal(result.report.sliversRemoved, 1);
  assert.equal(result.report.unresolvedSlivers, 0);
  assert.equal(result.report.issues[0]?.status, "Removed");
  assert.equal(result.geojson.features.length, fixture.features.length - 1);
  assert.equal(
    result.geojson.features.some(
      (feature: { id?: string }) => feature.id === "sliver",
    ),
    false,
  );
  assert.deepEqual(fixture, before);
});

test("keeps compactness-only narrow parcels for manual review", () => {
  const fixture = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "narrow-parcel",
        properties: { owner: "preserved" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [51.3842, 35.68],
            [51.38425, 35.68],
            [51.38425, 35.682],
            [51.3842, 35.682],
            [51.3842, 35.68],
          ]],
        },
      },
    ],
  };
  const result = processSlivers(
    fixture,
    { sliverAreaThresholdM2: 0.0625 },
    true,
  );

  assert.equal(result.report.sliversFound, 1);
  assert.equal(result.report.sliversRemoved, 0);
  assert.equal(result.report.unresolvedSlivers, 1);
  assert.equal(result.report.issues[0]?.recommendedAction, "ManualReview");
  assert.equal(result.geojson, fixture);
});

test("removes only the undersized component of a MultiPolygon", () => {
  const tiny = [
    [
      [0, 0],
      [0.000001, 0],
      [0.000001, 0.000001],
      [0, 0.000001],
      [0, 0],
    ],
  ];
  const normal = [
    [
      [1, 0],
      [1.001, 0],
      [1.001, 0.001],
      [1, 0.001],
      [1, 0],
    ],
  ];
  const fixture = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "multipart",
        properties: { parcel: "kept" },
        geometry: { type: "MultiPolygon", coordinates: [tiny, normal] },
      },
    ],
  };
  const result = processSlivers(
    fixture,
    { sliverAreaThresholdM2: 0.09 },
    true,
  );

  assert.equal(result.report.sliversRemoved, 1);
  assert.equal(result.geojson.features.length, 1);
  assert.deepEqual(
    result.geojson.features[0]!.geometry.coordinates,
    [normal],
  );
  assert.deepEqual(result.geojson.features[0]!.properties, { parcel: "kept" });
});
