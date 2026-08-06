import assert from "node:assert/strict";
import test from "node:test";
import { detectTinyPolygons } from "./detector";

const polygonCollection = (ring: number[][]) => ({
  type: "FeatureCollection",
  features: [
    {
      geometry: { type: "Polygon", coordinates: [ring] },
    },
  ],
});

test("detects a strictly positive polygon below the area threshold", () => {
  const result = detectTinyPolygons(
    polygonCollection([
      [0, 0],
      [0.000001, 0],
      [0.000001, 0.000001],
      [0, 0],
    ]),
    { tinyPolygonAreaM2: 1 },
  );

  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0]!.areaM2 > 0);
  assert.ok(result.findings[0]!.areaM2 < 1);
});

test("excludes exact zero area polygons", () => {
  const result = detectTinyPolygons(
    polygonCollection([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
    ]),
    { tinyPolygonAreaM2: Number.MAX_VALUE },
  );

  assert.equal(result.findings.length, 0);
});

test("a zero threshold disables tiny polygon findings", () => {
  const result = detectTinyPolygons(
    polygonCollection([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]),
    { tinyPolygonAreaM2: 0 },
  );
  assert.equal(result.findings.length, 0);
});

test("rejects invalid area thresholds", () => {
  assert.throws(
    () =>
      detectTinyPolygons(polygonCollection([]), {
        tinyPolygonAreaM2: -1,
      }),
    /finite non-negative/,
  );
});
