import assert from "node:assert/strict";
import test from "node:test";
import { detectMultipartIntegrity } from "./detector";

const square = (minX: number, minY: number, size = 2) => [
  [minX, minY],
  [minX + size, minY],
  [minX + size, minY + size],
  [minX, minY + size],
  [minX, minY],
];

const collection = (coordinates: unknown) => ({
  type: "FeatureCollection",
  features: [
    { geometry: { type: "MultiPolygon", coordinates } },
  ],
});

test("accepts disjoint and boundary-touching components", () => {
  const result = detectMultipartIntegrity(
    collection([
      [square(0, 0)],
      [square(2, 0)],
      [square(10, 10)],
    ]),
  );
  assert.equal(result.findings.length, 0);
});

test("detects positive-area overlap between components", () => {
  const result = detectMultipartIntegrity(
    collection([[square(0, 0)], [square(1, 1)]]),
  );
  assert.equal(result.findings[0]?.code, "OVERLAPPING_POLYGON_COMPONENTS");
  assert.ok(result.findings[0]!.overlapAreaM2! > 0);
});

test("detects rotated duplicate polygon components", () => {
  const first = square(0, 0);
  const rotated = [...first.slice(2, -1), ...first.slice(0, 2)];
  rotated.push([...rotated[0]!]);
  const result = detectMultipartIntegrity(
    collection([[first], [rotated]]),
  );
  assert.equal(result.findings[0]?.code, "DUPLICATE_POLYGON_COMPONENT");
});

test("detects empty and malformed multipart components", () => {
  assert.equal(
    detectMultipartIntegrity(collection([])).findings[0]?.code,
    "EMPTY_MULTIPOLYGON",
  );
  assert.equal(
    detectMultipartIntegrity(collection([[]])).findings[0]?.code,
    "INVALID_POLYGON_COMPONENT",
  );
});

test("reports nested geometry collection paths", () => {
  const result = detectMultipartIntegrity({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "MultiPolygon",
              coordinates: [],
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(result.findings[0]?.geometryCollectionPath, [0]);
});
