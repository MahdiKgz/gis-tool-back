import assert from "node:assert/strict";
import test from "node:test";
import { prepareOutputCoordinates } from "./output";

test("output rounding preserves every coordinate ordinate", () => {
  const input = {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [1.123456789, 2.5, 100, 42],
    },
    properties: null,
  };

  const result = prepareOutputCoordinates(input);

  assert.deepEqual(result.geometry.coordinates, [
    1.123456789,
    2.5,
    100,
    42,
  ]);
  assert.notEqual(result, input);
});
