import assert from "node:assert/strict";
import test from "node:test";
import { detectNeighborInconsistencies } from "./detector";

const feature = (id: string, coordinates: number[][], layer = "parcels") => ({
  type: "Feature",
  id,
  properties: {},
  snapgisCadLayer: layer,
  geometry: { type: "Polygon", coordinates: [coordinates] },
});

test("detects a missing vertex in an otherwise coincident shared boundary", () => {
  const result = detectNeighborInconsistencies({
    type: "FeatureCollection",
    features: [
      feature("west", [
        [0, 0],
        [1, 0],
        [1, 0.5],
        [1, 1],
        [0, 1],
        [0, 0],
      ]),
      feature("east", [
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 0],
      ]),
    ],
  });

  assert.equal(result.polygonComponentsScanned, 2);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    code: "NEIGHBOR_VERTEX_MISMATCH",
    featureIndex: 0,
    featureId: "west",
    relatedFeatureIndex: 1,
    relatedFeatureId: "east",
    geometryType: "Polygon",
    relatedGeometryType: "Polygon",
    geometryCollectionPath: [],
    relatedGeometryCollectionPath: [],
    polygonPath: [],
    relatedPolygonPath: [],
    coordinatePath: [0, 2],
    relatedCoordinatePath: [0, 3],
    vertexPosition: [1, 0.5],
    insertionPosition: [1, 0.5],
    targetSegmentStart: [1, 1],
    targetSegmentEnd: [1, 0],
    targetSegmentFraction: 0.5,
    offsetMeters: 0,
    candidateTargetCount: 1,
    repairable: true,
  });
});

test("does not confuse a corner or a cross-layer contact with a missing neighbor vertex", () => {
  const result = detectNeighborInconsistencies({
    type: "FeatureCollection",
    features: [
      feature("corner", [
        [0, 0],
        [1, 0.5],
        [0, 1],
        [0, 0],
      ]),
      feature("edge", [
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 0],
      ]),
      feature(
        "other-layer",
        [
          [0, 0],
          [1, 0],
          [1, 0.5],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
        "buildings",
      ),
    ],
  });

  assert.deepEqual(result.findings, []);
});

test("does not treat a true boundary crossing as coincident neighbor segmentation", () => {
  const result = detectNeighborInconsistencies({
    type: "FeatureCollection",
    features: [
      feature("horizontal", [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
        [0, 1],
        [0, 0],
      ]),
      feature("vertical", [
        [1, -1],
        [1.5, -1],
        [1.5, 1],
        [1, 1],
        [1, -1],
      ]),
    ],
  });

  assert.deepEqual(result.findings, []);
});

test("marks a mismatch with multiple coincident targets as ambiguous", () => {
  const west = feature("west", [
    [0, 0],
    [1, 0],
    [1, 0.5],
    [1, 1],
    [0, 1],
    [0, 0],
  ]);
  const eastCoordinates = [
    [1, 0],
    [2, 0],
    [2, 1],
    [1, 1],
    [1, 0],
  ];
  const result = detectNeighborInconsistencies({
    type: "FeatureCollection",
    features: [
      west,
      feature("east-a", eastCoordinates),
      feature("east-b", eastCoordinates),
    ],
  });

  const mismatch = result.findings.find(
    (finding) => finding.featureId === "west",
  );
  assert.ok(mismatch);
  assert.equal(mismatch.candidateTargetCount, 2);
  assert.equal(mismatch.repairable, false);
});

test("validates the coincidence tolerance", () => {
  assert.throws(
    () =>
      detectNeighborInconsistencies(
        { type: "FeatureCollection", features: [] },
        { coincidenceToleranceMeters: 0 },
      ),
    RangeError,
  );
});
