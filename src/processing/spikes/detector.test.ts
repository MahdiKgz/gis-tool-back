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

test("honors the configurable shoulder tolerance", () => {
  const geometry = {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.001, 0.001],
      [0.000001, 0],
    ],
  };

  assert.equal(
    detectSpikes(collection(geometry), {
      baseToleranceMeters: 0.05,
    }).findings.length,
    0,
  );
  assert.equal(
    detectSpikes(collection(geometry), {
      baseToleranceMeters: 0.2,
    }).findings.length,
    1,
  );
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
