import assert from "node:assert/strict";
import test from "node:test";
import { detectOpenRings } from "./detector";

test("accepts an exactly closed ring", () => {
  const result = detectOpenRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [1, 2],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.ringsScanned, 1);
  assert.deepEqual(result.findings, []);
});

test("detects a valid open ring as repairable", () => {
  const result = detectOpenRings({
    type: "FeatureCollection",
    features: [
      {
        properties: { id: "parcel-7" },
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
  });

  assert.deepEqual(result.findings[0], {
    code: "OPEN_RING",
    featureIndex: 0,
    featureId: "parcel-7",
    geometryType: "Polygon",
    geometryCollectionPath: [],
    coordinatePath: [0],
    role: "exterior",
    positionCount: 3,
    distinctVertexCount: 3,
    invalidCoordinateIndices: [],
    repairable: true,
    blockedReason: null,
  });
});

test("reports a detectably open corrupted ring without repairing it", () => {
  const result = detectOpenRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              null,
              [2, 0],
              [1, 2],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.repairable, false);
  assert.equal(result.findings[0]?.blockedReason, "CORRUPTED_RING");
  assert.deepEqual(result.findings[0]?.invalidCoordinateIndices, [1]);
});

test("reports an open ring with insufficient vertices without repairing it", () => {
  const result = detectOpenRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.repairable, false);
  assert.equal(
    result.findings[0]?.blockedReason,
    "INSUFFICIENT_VERTICES",
  );
});

test("defers rings with invalid endpoints to invalid-ring validation", () => {
  const result = detectOpenRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              null,
              [2, 0],
              [1, 2],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.ringsScanned, 1);
  assert.deepEqual(result.findings, []);
});
