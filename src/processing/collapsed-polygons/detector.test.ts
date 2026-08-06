import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePolygonAreaBaseline,
  detectCollapsedPolygons,
} from "./detector";

const collection = (coordinates: unknown) => ({
  type: "FeatureCollection",
  features: [
    {
      id: "parcel",
      geometry: { type: "Polygon", coordinates },
    },
  ],
});

test("detects a positive-area polygon that becomes zero area", () => {
  const before = collection([
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 0],
    ],
  ]);
  const after = collection([
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
    ],
  ]);

  const result = detectCollapsedPolygons(
    capturePolygonAreaBaseline(before),
    after,
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.collapseKind, "ZeroArea");
  assert.ok(result.findings[0]!.beforeAreaM2 > 0);
  assert.equal(result.findings[0]?.afterAreaM2, 0);
});

test("reports a positive-area component missing after repair", () => {
  const before = collection([
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 0],
    ],
  ]);
  const result = detectCollapsedPolygons(
    capturePolygonAreaBaseline(before),
    { type: "FeatureCollection", features: [] },
  );

  assert.equal(result.findings[0]?.collapseKind, "Missing");
  assert.equal(result.findings[0]?.afterAreaM2, null);
});

test("does not include pre-existing zero-area components in the baseline", () => {
  const zero = collection([
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
    ],
  ]);

  assert.equal(capturePolygonAreaBaseline(zero).entries.length, 0);
});
