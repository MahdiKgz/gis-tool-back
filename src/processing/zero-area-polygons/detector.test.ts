import assert from "node:assert/strict";
import test from "node:test";
import { detectZeroAreaPolygons } from "./detector";

test("detects a closed collinear polygon as zero area", () => {
  const result = detectZeroAreaPolygons({
    type: "FeatureCollection",
    features: [
      {
        id: "zero",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [2, 0],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.polygonsScanned, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.areaM2, 0);
});

test("does not classify a nonzero polygon as zero area", () => {
  const result = detectZeroAreaPolygons({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 0);
});

test("reports the component path in nested multipart geometry", () => {
  const zeroRing = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 0],
  ];
  const result = detectZeroAreaPolygons({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "MultiPolygon",
              coordinates: [[zeroRing], [zeroRing]],
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[1]?.geometryCollectionPath, [0]);
  assert.deepEqual(result.findings[1]?.polygonPath, [1]);
});
