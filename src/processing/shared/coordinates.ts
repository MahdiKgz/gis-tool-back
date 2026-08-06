export type Position = number[];

export const isFinitePosition = (value: unknown): value is Position =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.every(
    (ordinate) => typeof ordinate === "number" && Number.isFinite(ordinate),
  );

export const positionsEqual = (
  first: Position,
  second: Position,
): boolean =>
  first.length === second.length &&
  first.every(
    (ordinate, index) =>
      Object.is(ordinate, second[index]) ||
      (ordinate === 0 && second[index] === 0),
  );

export const positionKey = (position: Position): string =>
  JSON.stringify(
    position.map((ordinate) => (Object.is(ordinate, -0) ? 0 : ordinate)),
  );
