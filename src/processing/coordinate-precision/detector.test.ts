import assert from "node:assert/strict";
import test from "node:test";
import { detectCoordinatePrecision } from "./detector";

const collection = (geometry: unknown) => ({
  type: "FeatureCollection",
  features: [{ geometry: geometry as any }],
});

test("detects values changed by configured decimal rounding", () => {
  const result = detectCoordinatePrecision(
    collection({
      type: "Point",
      coordinates: [1.1234567891, 2],
    }),
    { maxDecimalPlaces: 9 },
  );

  assert.equal(
    result.findings[0]?.code,
    "EXCESSIVE_COORDINATE_PRECISION",
  );
  assert.equal(result.findings[0]?.decimalPlaces, 10);
  assert.equal(result.findings[0]?.roundedValue, 1.123456789);
});

test("handles scientific notation precision deterministically", () => {
  const result = detectCoordinatePrecision(
    collection({ type: "Point", coordinates: [1e-10, 0] }),
    { maxDecimalPlaces: 9 },
  );
  assert.equal(result.findings[0]?.decimalPlaces, 10);
  assert.equal(result.findings[0]?.roundedValue, 0);
});

test("detects distinct XY positions that collide on the rounding grid", () => {
  const result = detectCoordinatePrecision(
    collection({
      type: "LineString",
      coordinates: [[0, 0], [0.0000000004, 0], [1, 0]],
    }),
    { maxDecimalPlaces: 9 },
  );

  const collision = result.findings.find(
    (finding) => finding.code === "ROUNDING_COLLISION",
  );
  assert.deepEqual(collision?.coordinatePath, [1]);
  assert.deepEqual(collision?.relatedCoordinatePath, [0]);
});

test("does not report an exact ring closure as a rounding collision", () => {
  const result = detectCoordinatePrecision(
    collection({
      type: "Polygon",
      coordinates: [
        [[0, 0], [1, 0], [1, 1], [0, 0]],
      ],
    }),
    { maxDecimalPlaces: 9 },
  );
  assert.equal(result.findings.length, 0);
});

test("detects magnitudes that cannot safely address the precision grid", () => {
  const result = detectCoordinatePrecision(
    collection({
      type: "Point",
      coordinates: [10000000.125, 0],
    }),
    { maxDecimalPlaces: 9 },
  );
  assert.equal(result.findings[0]?.code, "UNSAFE_COORDINATE_MAGNITUDE");
});

test("rejects invalid precision configuration", () => {
  assert.throws(
    () =>
      detectCoordinatePrecision(collection(null), {
        maxDecimalPlaces: 16,
      }),
    /integer between 0 and 15/,
  );
});
