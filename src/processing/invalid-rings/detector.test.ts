import assert from "node:assert/strict";
import test from "node:test";
import { detectInvalidRings } from "./detector";

test("accepts a closed ring with three distinct vertices", () => {
  const result = detectInvalidRings({
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

test("detects an otherwise valid unclosed ring as safely repairable", () => {
  const result = detectInvalidRings({
    type: "FeatureCollection",
    features: [
      {
        id: "open-parcel",
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

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    code: "UNCLOSED_RING",
    type: "unclosed",
    featureIndex: 0,
    featureId: "open-parcel",
    geometryType: "Polygon",
    geometryCollectionPath: [],
    coordinatePath: [0],
    role: "exterior",
    positionCount: 3,
    distinctVertexCount: 3,
    invalidCoordinateIndices: [],
    corruptionReason: null,
    repairable: true,
  });
});

test("reports invalid coordinate content as corruption without guessing a repair", () => {
  const result = detectInvalidRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [2, 0],
              null,
              [1, 2],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.type, "corrupted");
  assert.equal(result.findings[0]?.corruptionReason, "INVALID_POSITION");
  assert.deepEqual(result.findings[0]?.invalidCoordinateIndices, [2]);
  assert.equal(result.findings[0]?.repairable, false);
});

test("reports empty rings as corrupted and insufficient", () => {
  const result = detectInvalidRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [[]],
        },
      },
    ],
  });

  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ["corrupted", "insufficient-vertices"],
  );
  assert.equal(result.findings[0]?.corruptionReason, "EMPTY_RING");
  assert.equal(result.findings[1]?.distinctVertexCount, 0);
});

test("reports a non-array ring container as corrupted", () => {
  const result = detectInvalidRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [null],
        },
      },
    ],
  });

  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ["corrupted", "insufficient-vertices"],
  );
  assert.equal(result.findings[0]?.corruptionReason, "RING_NOT_ARRAY");
  assert.deepEqual(result.findings[0]?.coordinatePath, [0]);
});

test("reports a closed ring with fewer than three distinct vertices", () => {
  const result = detectInvalidRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.type, "insufficient-vertices");
  assert.equal(result.findings[0]?.distinctVertexCount, 2);
  assert.equal(result.findings[0]?.repairable, false);
});

test("rejects non-finite positions as corrupted", () => {
  const result = detectInvalidRings({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [2, Number.POSITIVE_INFINITY],
              [1, 2],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings[0]?.type, "corrupted");
  assert.deepEqual(result.findings[0]?.invalidCoordinateIndices, [1]);
});
