import {
  Position,
  positionsEqual,
} from "./coordinates";

const coordinateToken = (
  position: Position,
  decimalPlaces: number | undefined,
): string =>
  position
    .slice(0, 2)
    .map((ordinate) => {
      const normalized = Object.is(ordinate, -0) ? 0 : ordinate;
      return decimalPlaces === undefined
        ? String(normalized)
        : normalized.toFixed(decimalPlaces);
    })
    .join(",");

export const stripClosingPosition = (ring: Position[]): Position[] => {
  if (
    ring.length > 1 &&
    positionsEqual(ring[0]!, ring[ring.length - 1]!)
  ) {
    return ring.slice(0, -1);
  }
  return ring.slice();
};

// Booth's algorithm finds the lexicographically least cyclic rotation in
// linear time. Applying it in both directions makes the signature invariant
// to starting vertex and winding without an O(n²) rotation scan.
const leastRotation = (tokens: string[]): string[] => {
  if (tokens.length < 2) return tokens.slice();

  const doubled = [...tokens, ...tokens];
  let first = 0;
  let second = 1;
  let offset = 0;

  while (
    first < tokens.length &&
    second < tokens.length &&
    offset < tokens.length
  ) {
    const firstToken = doubled[first + offset]!;
    const secondToken = doubled[second + offset]!;

    if (firstToken === secondToken) {
      offset++;
      continue;
    }

    if (firstToken > secondToken) {
      first += offset + 1;
      if (first <= second) first = second + 1;
    } else {
      second += offset + 1;
      if (second <= first) second = first + 1;
    }
    offset = 0;
  }

  const start = Math.min(first, second);
  return doubled.slice(start, start + tokens.length);
};

export const canonicalRingSignature = (
  ring: Position[],
  decimalPlaces?: number,
): string => {
  const tokens = stripClosingPosition(ring).map((position) =>
    coordinateToken(position, decimalPlaces),
  );
  const forward = leastRotation(tokens).join("|");
  const reversed = leastRotation([...tokens].reverse()).join("|");
  return forward < reversed ? forward : reversed;
};
