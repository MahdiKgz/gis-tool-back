import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRingSignature } from "../shared/ring-signature";
import { detectInvalidHoles } from "./detector";
import { classifyRingContainment } from "./spatial";

const polygonCollection = (coordinates: unknown) => ({
  type: "FeatureCollection",
  features: [
    {
      id: "test-polygon",
      geometry: { type: "Polygon", coordinates },
    },
  ],
});

const exterior = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

test("detects a hole outside its exterior ring", () => {
  const outsideHole = [
    [12, 12],
    [12, 14],
    [14, 14],
    [14, 12],
    [12, 12],
  ];
  const result = detectInvalidHoles(
    polygonCollection([exterior, outsideHole]),
    { tinyHoleAreaM2: 0 },
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ["outside"],
  );
  assert.equal(result.findings[0]?.repairable, true);
});

test("detects a hole touching the exterior boundary without calling it outside", () => {
  const touchingHole = [
    [0, 2],
    [0, 4],
    [2, 4],
    [2, 2],
    [0, 2],
  ];
  const result = detectInvalidHoles(
    polygonCollection([exterior, touchingHole]),
    { tinyHoleAreaM2: 0 },
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ["touching-boundary"],
  );
  assert.equal(result.findings[0]?.repairable, false);
});

test("detects nested holes using spatial candidates", () => {
  const outerHole = [
    [2, 2],
    [2, 8],
    [8, 8],
    [8, 2],
    [2, 2],
  ];
  const innerHole = [
    [3, 3],
    [3, 4],
    [4, 4],
    [4, 3],
    [3, 3],
  ];
  const result = detectInvalidHoles(
    polygonCollection([exterior, outerHole, innerHole]),
    { tinyHoleAreaM2: 0 },
  );

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.type, "nested");
  assert.deepEqual(result.findings[0]?.coordinatePath, [2]);
  assert.deepEqual(result.findings[0]?.relatedHoleCoordinatePath, [1]);
});

test("detects rotated duplicate holes with a canonical signature", () => {
  const firstHole = [
    [2, 2],
    [2, 4],
    [4, 4],
    [4, 2],
    [2, 2],
  ];
  const rotatedHole = [
    [4, 4],
    [4, 2],
    [2, 2],
    [2, 4],
    [4, 4],
  ];
  assert.equal(
    canonicalRingSignature(firstHole),
    canonicalRingSignature(rotatedHole),
  );

  const result = detectInvalidHoles(
    polygonCollection([exterior, firstHole, rotatedHole]),
    { tinyHoleAreaM2: 0 },
  );

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.type, "duplicate");
  assert.deepEqual(result.findings[0]?.coordinatePath, [2]);
  assert.deepEqual(result.findings[0]?.relatedHoleCoordinatePath, [1]);
});

test("does not merge holes whose coordinates only differ below display precision", () => {
  const firstHole = [
    [2, 2],
    [2, 4],
    [4, 4],
    [4, 2],
    [2, 2],
  ];
  const distinctHole = [
    [2.0000000001, 2],
    [2, 4],
    [4, 4],
    [4, 2],
    [2.0000000001, 2],
  ];

  assert.notEqual(
    canonicalRingSignature(firstHole),
    canonicalRingSignature(distinctHole),
  );
  assert.equal(
    canonicalRingSignature(firstHole, 9),
    canonicalRingSignature(distinctHole, 9),
  );
});

test("detects self-intersecting holes without cascading area findings", () => {
  const bowTieHole = [
    [2, 2],
    [6, 6],
    [2, 6],
    [6, 2],
    [2, 2],
  ];
  const result = detectInvalidHoles(
    polygonCollection([exterior, bowTieHole]),
    { tinyHoleAreaM2: Number.MAX_VALUE },
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ["self-intersecting"],
  );
  assert.equal(result.findings[0]?.holeAreaM2, null);
});

test("detects tiny holes using the configured square-metre threshold", () => {
  const tinyHole = [
    [1, 1],
    [1, 1.000001],
    [1.000001, 1.000001],
    [1.000001, 1],
    [1, 1],
  ];
  const result = detectInvalidHoles(
    polygonCollection([exterior, tinyHole]),
    { tinyHoleAreaM2: 1 },
  );

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.type, "tiny");
  assert.equal(result.findings[0]?.repairable, true);
});

test("detects a hole larger than the exterior polygon", () => {
  const smallExterior = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  const largerHole = [
    [-1, -1],
    [-1, 2],
    [2, 2],
    [2, -1],
    [-1, -1],
  ];
  const result = detectInvalidHoles(
    polygonCollection([smallExterior, largerHole]),
    { tinyHoleAreaM2: 0 },
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ["outside", "larger-than-polygon"],
  );
});

test("detects a concavity crossing even when all hole vertices are inside", () => {
  const concaveExterior = [
    [0, 0],
    [6, 0],
    [6, 6],
    [4, 6],
    [4, 2],
    [2, 2],
    [2, 6],
    [0, 6],
    [0, 0],
  ];
  const crossingRing = [
    [1, 4],
    [5, 4],
    [5, 5],
    [1, 5],
    [1, 4],
  ];

  assert.equal(
    classifyRingContainment(crossingRing, concaveExterior).outside,
    true,
  );
});

test("classifies a concave-boundary overlap as touching rather than outside", () => {
  const concaveExterior = [
    [0, 0],
    [6, 0],
    [6, 6],
    [4, 6],
    [4, 2],
    [2, 2],
    [2, 6],
    [0, 6],
    [0, 0],
  ];
  const boundaryOverlap = [
    [1, 2],
    [5, 2],
    [5, 1],
    [1, 1],
    [1, 2],
  ];

  assert.deepEqual(
    classifyRingContainment(boundaryOverlap, concaveExterior),
    {
      outside: false,
      touching: true,
      strictlyInside: false,
    },
  );
});

test("rejects invalid tiny-hole thresholds", () => {
  assert.throws(
    () =>
      detectInvalidHoles(polygonCollection([exterior]), {
        tinyHoleAreaM2: -1,
      }),
    /finite non-negative/,
  );
});

test("defers open rings to the earlier structural validation stages", () => {
  const openExterior = exterior.slice(0, -1);
  const validHole = [
    [2, 2],
    [2, 4],
    [4, 4],
    [4, 2],
    [2, 2],
  ];

  assert.deepEqual(
    detectInvalidHoles(
      polygonCollection([openExterior, validHole]),
      { tinyHoleAreaM2: 0 },
    ),
    { holesScanned: 0, findings: [] },
  );
});
