import assert from "node:assert/strict";
import test from "node:test";
import { GeometryLike } from "../shared/geojson";
import { detectSpikes } from "./detector";

const collection = (geometry: GeometryLike | null) => ({
  type: "FeatureCollection",
  features: [{ id: "candidate", geometry }],
});

test("detects a narrow line backtrack within the configured tolerance", () => {
  const result = detectSpikes(
    collection({
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.001, 0.001],
        [0.0000001, 0],
        [1, 0],
      ],
    }),
    { baseToleranceMeters: 0.02 },
  );

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]?.coordinatePath, [1]);
  assert.ok(result.findings[0]!.tipAngleDegrees < 1);
});

test("does not classify an ordinary sharp corner as a spike", () => {
  const result = detectSpikes(
    collection({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    }),
    { baseToleranceMeters: 1 },
  );

  assert.equal(result.findings.length, 0);
});

test("uses shoulder tolerance for repair eligibility, not detection", () => {
  const geometry = {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.001, 0.001],
      [0.000001, 0],
    ],
  };

  const reportOnly = detectSpikes(collection(geometry), {
    baseToleranceMeters: 0.05,
  });
  const repairable = detectSpikes(collection(geometry), {
    baseToleranceMeters: 0.2,
  });
  assert.equal(reportOnly.findings.length, 1);
  assert.equal(reportOnly.findings[0]?.repairable, false);
  assert.equal(repairable.findings.length, 1);
  assert.equal(repairable.findings[0]?.repairable, true);
});

test("reports a scale-independent cadastral spike for manual review", () => {
  const result = detectSpikes(
    collection({
      type: "Polygon",
      coordinates: [[
        [51.3875, 35.68],
        [51.3895, 35.68],
        [51.3895, 35.682],
        [51.39, 35.6845],
        [51.3894, 35.682],
        [51.3875, 35.682],
        [51.3875, 35.68],
      ]],
    }),
    { baseToleranceMeters: 0.025 },
  );

  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0]!.baseWidthMeters > 9);
  assert.ok(result.findings[0]!.tipAngleDegrees < 2);
  assert.equal(result.findings[0]?.repairable, false);
});

test("rejects invalid spike configuration", () => {
  assert.throws(
    () =>
      detectSpikes(collection(null), {
        baseToleranceMeters: -1,
      }),
    /finite non-negative/,
  );
  assert.throws(
    () =>
      detectSpikes(collection(null), {
        baseToleranceMeters: 1,
        maxTipAngleDegrees: 180,
      }),
    /between 0 and 180/,
  );
});
