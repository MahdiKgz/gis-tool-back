import assert from "node:assert/strict";
import test from "node:test";
import { GeometryLike } from "../shared/geojson";
import { detectSelfIntersections } from "./detector";

const collection = (geometry: GeometryLike | null) => ({
  type: "FeatureCollection",
  features: [{ id: "candidate", geometry }],
});

test("detects a bow-tie crossing and returns both segment locations", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 2],
          [0, 2],
          [2, 0],
          [0, 0],
        ],
      ],
    }),
  );

  assert.equal(result.ringsScanned, 1);
  assert.equal(result.segmentsScanned, 4);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.intersectionKind, "Crossing");
  assert.deepEqual(result.findings[0]?.coordinatePath, [0, 0]);
  assert.deepEqual(result.findings[0]?.relatedCoordinatePath, [0, 2]);
  assert.deepEqual(result.findings[0]?.intersectionGeometry, {
    type: "Point",
    coordinates: [1, 1],
  });
});

test("detects crossings in small geographic-coordinate polygons", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [51.4, 35.7],
          [51.4000001, 35.7000001],
          [51.4, 35.7000001],
          [51.4000001, 35.7],
          [51.4, 35.7],
        ],
      ],
    }),
  );

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.intersectionKind, "Crossing");
});

test("does not classify adjacent vertices of a valid ring as intersections", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    }),
  );

  assert.deepEqual(result.findings, []);
});

test("does not turn a consecutive duplicate vertex into a self-intersection", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    }),
  );

  assert.deepEqual(result.findings, []);
});

test("detects a non-adjacent boundary touch", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [1, 1],
          [1, 0],
          [0, 2],
          [0, 0],
        ],
      ],
    }),
  );

  assert.ok(
    result.findings.some(
      (finding) =>
        finding.intersectionKind === "Touching" &&
        finding.intersectionGeometry.type === "Point" &&
        finding.intersectionGeometry.coordinates[0] === 1 &&
        finding.intersectionGeometry.coordinates[1] === 0,
    ),
  );
});

test("detects collinear overlap between non-adjacent segments", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [1, 0],
          [3, 0],
          [0, 4],
          [0, 0],
        ],
      ],
    }),
  );

  const overlap = result.findings.find(
    (finding) => finding.intersectionKind === "Overlapping",
  );
  assert.ok(overlap);
  assert.deepEqual(overlap.intersectionGeometry, {
    type: "LineString",
    coordinates: [
      [1, 0],
      [3, 0],
    ],
  });
});

test("skips malformed and open rings delegated to structural checks", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 2],
          [0, 2],
          [2, 0],
        ],
      ],
    }),
  );

  assert.equal(result.ringsScanned, 1);
  assert.equal(result.segmentsScanned, 0);
  assert.deepEqual(result.findings, []);
});

test("leaves self-intersecting holes to invalid-hole validation", () => {
  const result = detectSelfIntersections(
    collection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [3, 3],
          [1, 3],
          [3, 1],
          [1, 1],
        ],
      ],
    }),
  );

  assert.equal(result.ringsScanned, 1);
  assert.deepEqual(result.findings, []);
});
