import assert from "node:assert/strict";
import test from "node:test";
import { detectDuplicateVertices } from "./detector";

test("detects redundant polygon vertices but ignores the required closure", () => {
  const findings = detectDuplicateVertices({
    type: "FeatureCollection",
    features: [
      {
        id: "parcel-1",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [2, 0],
              [2, 2],
              [0, 2],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    code: "DUPLICATE_VERTEX",
    featureIndex: 0,
    featureId: "parcel-1",
    geometryType: "Polygon",
    geometryCollectionPath: [],
    coordinatePath: [0, 2],
    duplicateOfCoordinatePath: [0, 1],
    kind: "consecutive",
    repairable: true,
  });
});

test("reports non-consecutive repeats without marking them repairable", () => {
  const findings = detectDuplicateVertices({
    type: "FeatureCollection",
    features: [
      {
        properties: { id: 42 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
            [0, 0],
          ],
        },
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "non-consecutive");
  assert.equal(findings[0]?.repairable, false);
  assert.deepEqual(findings[0]?.coordinatePath, [2]);
  assert.deepEqual(findings[0]?.duplicateOfCoordinatePath, [0]);
});

test("does not repair a duplicate pair that would collapse a line", () => {
  const findings = detectDuplicateVertices({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [5, 5],
            [5, 5],
          ],
        },
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "consecutive");
  assert.equal(findings[0]?.repairable, false);
});

test("preserves coordinate dimensions when comparing positions", () => {
  const findings = detectDuplicateVertices({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0, 10],
            [0, 0, 20],
            [0, 0, 20],
          ],
        },
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.coordinatePath, [2]);
});

test("detects extra closing coordinates while retaining one ring closure", () => {
  const findings = detectDuplicateVertices({
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
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "consecutive");
  assert.equal(findings[0]?.repairable, true);
  assert.deepEqual(findings[0]?.coordinatePath, [0, 3]);
  assert.deepEqual(findings[0]?.duplicateOfCoordinatePath, [0, 4]);
});
