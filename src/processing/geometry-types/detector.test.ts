import assert from "node:assert/strict";
import test from "node:test";
import {
  detectGeometryTypes,
  SUPPORTED_GEOMETRY_TYPES,
} from "./detector";

test("accepts every RFC 7946 geometry type and null feature geometry", () => {
  const geometries = [
    { type: "Point", coordinates: [0, 0] },
    { type: "MultiPoint", coordinates: [[0, 0]] },
    { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]] },
    {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [0, 0]]],
    },
    {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [1, 0], [0, 0]]]],
    },
    { type: "GeometryCollection", geometries: [] },
    null,
  ];
  const result = detectGeometryTypes({
    type: "FeatureCollection",
    features: geometries.map((geometry) => ({ geometry })),
  });

  assert.equal(SUPPORTED_GEOMETRY_TYPES.size, 7);
  assert.equal(result.rootValid, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.geometriesScanned, 7);
});

test("reports unsupported, missing, and non-object geometries", () => {
  const result = detectGeometryTypes({
    type: "FeatureCollection",
    features: [
      { geometry: { type: "CircularString", coordinates: [] } },
      { geometry: { coordinates: [] } },
      { geometry: "Polygon" as any },
    ],
  });

  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    [
      "UNSUPPORTED_GEOMETRY_TYPE",
      "MISSING_GEOMETRY_TYPE",
      "INVALID_GEOMETRY_OBJECT",
    ],
  );
});

test("reports a malformed feature entry without throwing", () => {
  const result = detectGeometryTypes({
    type: "FeatureCollection",
    features: [null as any],
  });

  assert.equal(result.findings[0]?.code, "INVALID_FEATURE_OBJECT");
  assert.equal(result.findings[0]?.featureIndex, 0);
});

test("reports an invalid nested geometry with its collection path", () => {
  const result = detectGeometryTypes({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "GeometryCollection",
          geometries: [
            { type: "Point", coordinates: [0, 0] },
            { type: "Arc", coordinates: [] },
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]?.geometryCollectionPath, [1]);
  assert.equal(result.findings[0]?.receivedType, "Arc");
});

test("rejects an invalid FeatureCollection root", () => {
  const result = detectGeometryTypes({
    type: "Feature",
    features: [],
  });
  assert.equal(result.rootValid, false);
  assert.match(result.rootError!, /FeatureCollection/);
});
