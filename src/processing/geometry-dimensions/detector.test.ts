import assert from "node:assert/strict";
import test from "node:test";
import { detectGeometryDimensions } from "./detector";

test("accepts consistent 2D, 3D, and 4D geometries", () => {
  const result = detectGeometryDimensions({
    type: "FeatureCollection",
    features: [
      { geometry: { type: "Point", coordinates: [0, 0] } },
      {
        geometry: {
          type: "LineString",
          coordinates: [[0, 0, 1], [1, 1, 2]],
        },
      },
      {
        geometry: {
          type: "MultiPoint",
          coordinates: [[0, 0, 1, 2], [1, 1, 2, 3]],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.positionsScanned, 5);
});

test("detects a position with fewer than two ordinates", () => {
  const result = detectGeometryDimensions({
    type: "FeatureCollection",
    features: [
      { geometry: { type: "Point", coordinates: [1] } },
    ],
  });

  assert.equal(result.findings[0]?.code, "INVALID_POSITION_DIMENSION");
  assert.equal(result.findings[0]?.actualDimension, 1);
});

test("detects inconsistent position dimensions within a geometry", () => {
  const result = detectGeometryDimensions({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [[0, 0], [1, 1, 5]],
        },
      },
    ],
  });

  assert.equal(
    result.findings[0]?.code,
    "INCONSISTENT_POSITION_DIMENSION",
  );
  assert.equal(result.findings[0]?.expectedDimension, 2);
  assert.equal(result.findings[0]?.actualDimension, 3);
});

test("allows geometry collection children to use different dimensions", () => {
  const result = detectGeometryDimensions({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "GeometryCollection",
          geometries: [
            { type: "Point", coordinates: [0, 0] },
            { type: "Point", coordinates: [0, 0, 5] },
          ],
        },
      },
    ],
  });
  assert.equal(result.findings.length, 0);
});

test("detects non-finite or non-numeric coordinate values", () => {
  const result = detectGeometryDimensions({
    type: "FeatureCollection",
    features: [
      { geometry: { type: "Point", coordinates: [0, "x"] } },
    ],
  });
  assert.equal(result.findings[0]?.code, "INVALID_COORDINATE_VALUE");
});
