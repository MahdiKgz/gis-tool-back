import assert from "node:assert/strict";
import test from "node:test";
import { detectRingOrientationIssues } from "./detector";
import { calculateRingOrientation } from "./orientation";

test("accepts RFC 7946 exterior and interior orientations", () => {
  const result = detectRingOrientationIssues({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [6, 0],
              [6, 6],
              [0, 6],
              [0, 0],
            ],
            [
              [1, 1],
              [1, 3],
              [3, 3],
              [3, 1],
              [1, 1],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.ringsScanned, 2);
  assert.equal(result.ringsEvaluated, 2);
  assert.deepEqual(result.findings, []);
});

test("detects incorrect exterior and interior ring orientations", () => {
  const result = detectRingOrientationIssues({
    type: "FeatureCollection",
    features: [
      {
        id: "parcel-orientation",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [0, 6],
              [6, 6],
              [6, 0],
              [0, 0],
            ],
            [
              [1, 1],
              [3, 1],
              [3, 3],
              [1, 3],
              [1, 1],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((finding) => ({
      code: finding.code,
      role: finding.role,
      actual: finding.actualOrientation,
      expected: finding.expectedOrientation,
      path: finding.coordinatePath,
      repairable: finding.repairable,
    })),
    [
      {
        code: "INCORRECT_RING_ORIENTATION",
        role: "exterior",
        actual: "clockwise",
        expected: "counterclockwise",
        path: [0],
        repairable: true,
      },
      {
        code: "INCORRECT_RING_ORIENTATION",
        role: "interior",
        actual: "counterclockwise",
        expected: "clockwise",
        path: [1],
        repairable: true,
      },
    ],
  );
});

test("reports a zero-signed-area ring as indeterminate", () => {
  const result = detectRingOrientationIssues({
    type: "FeatureCollection",
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 1],
              [2, 2],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(
    result.findings[0]?.code,
    "INDETERMINATE_RING_ORIENTATION",
  );
  assert.equal(result.findings[0]?.repairable, false);
});

test("defers malformed and open rings to earlier validation stages", () => {
  const result = detectRingOrientationIssues({
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
            ],
            [
              [0, 0],
              null,
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });

  assert.equal(result.ringsScanned, 2);
  assert.equal(result.ringsEvaluated, 0);
  assert.deepEqual(result.findings, []);
});

test("calculates orientation stably for large projected coordinates", () => {
  const ring = [
    [1_000_000_000, 1_000_000_000, 7],
    [1_000_000_000.01, 1_000_000_000, 7],
    [1_000_000_000.01, 1_000_000_000.01, 7],
    [1_000_000_000, 1_000_000_000.01, 7],
    [1_000_000_000, 1_000_000_000, 7],
  ];

  assert.equal(calculateRingOrientation(ring), "counterclockwise");
  assert.equal(
    calculateRingOrientation([...ring].reverse()),
    "clockwise",
  );
});
