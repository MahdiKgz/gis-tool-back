import { isFinitePosition, Position } from "../shared/coordinates";

export type RingOrientation =
  | "clockwise"
  | "counterclockwise"
  | "indeterminate";

export const calculateRingOrientation = (
  ring: unknown,
): RingOrientation => {
  if (
    !Array.isArray(ring) ||
    ring.length < 4 ||
    !ring.every(isFinitePosition)
  ) {
    return "indeterminate";
  }

  const origin = ring[0] as Position;
  let signedDoubleArea = 0;
  let compensation = 0;

  for (let index = 1; index < ring.length; index++) {
    const previous = ring[index - 1] as Position;
    const current = ring[index] as Position;
    const previousX = previous[0]! - origin[0]!;
    const previousY = previous[1]! - origin[1]!;
    const currentX = current[0]! - origin[0]!;
    const currentY = current[1]! - origin[1]!;
    const term = previousX * currentY - currentX * previousY;

    // Kahan compensated summation reduces cancellation for large projected
    // coordinates and very narrow rings without introducing a unit-specific
    // orientation tolerance.
    const adjustedTerm = term - compensation;
    const nextArea = signedDoubleArea + adjustedTerm;
    compensation = nextArea - signedDoubleArea - adjustedTerm;
    signedDoubleArea = nextArea;
  }

  if (!Number.isFinite(signedDoubleArea) || signedDoubleArea === 0) {
    return "indeterminate";
  }
  return signedDoubleArea > 0 ? "counterclockwise" : "clockwise";
};
