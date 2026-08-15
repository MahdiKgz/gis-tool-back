import assert from "node:assert/strict";
import test from "node:test";
import {
  closestPointsBetweenSegments,
  segmentIntersection,
} from "./spatial-segments";

test("finds an intersection between sub-millimetre coordinate segments", () => {
  const intersection = segmentIntersection(
    [0, 0],
    [0.000000002, 0],
    [0.000000001, -0.000000001],
    [0.000000001, 0.000000001],
  );

  assert.ok(intersection);
  assert.deepEqual(intersection.position, [0.000000001, 0]);
  assert.equal(intersection.firstFraction, 0.5);
  assert.equal(intersection.secondFraction, 0.5);
});

test("returns the true nearest points for separated diagonal segments", () => {
  const proximity = closestPointsBetweenSegments(
    [0, 0],
    [0.001, 0],
    [0.0010005, 0.0000005],
    [0.002, 0.001],
  );

  assert.deepEqual(proximity.firstPosition, [0.001, 0]);
  assert.deepEqual(proximity.secondPosition, [0.0010005, 0.0000005]);
  assert.ok(proximity.distanceMeters > 0.07);
});
