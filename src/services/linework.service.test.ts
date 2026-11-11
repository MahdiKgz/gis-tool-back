import assert from "node:assert/strict";
import test from "node:test";
import { buildLinework } from "./linework.service";

test("flattens polygon rings to MultiLineString while keeping CAD layer assignments and untouched points", () => {
  const shell = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 0],
  ];
  const hole = [
    [0.5, 0.1],
    [1, 0.1],
    [1, 0.4],
    [0.5, 0.1],
  ];
  const line = [
    [4, 0],
    [5, 2],
  ];
  const features = [
    {
      id: "land",
      geometry: { type: "MultiPolygon", coordinates: [[shell, hole], [shell]] },
      snapgisCadLayer: "زمین",
    },
    { id: "road", geometry: { type: "LineString", coordinates: line }, snapgisCadLayer: "معبر" },
    { id: "mark", geometry: { type: "Point", coordinates: [0, 0] }, snapgisCadLayer: "علائم" },
  ];
  const data = {
    type: "FeatureCollection",
    features,
    snapgisCadLayers: ["زمین", "معبر", "علائم", "خالی"],
  };
  const output = buildLinework(data);
  assert.deepEqual(output.snapgisCadLayers, data.snapgisCadLayers);
  assert.deepEqual(
    output.features?.map((feature) => feature.properties?.Layer),
    ["زمین", "معبر", "علائم"],
  );
  assert.deepEqual(
    output.features?.map((feature) => feature.geometry),
    [
      { type: "MultiLineString", coordinates: [shell, hole, shell] },
      { type: "MultiLineString", coordinates: [line] },
      features[2]?.geometry,
    ],
  );
  assert.equal(features[0]?.geometry.type, "MultiPolygon");
});
