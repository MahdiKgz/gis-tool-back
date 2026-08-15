import { Position } from "./coordinates";

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;
const LATITUDE_METERS_PER_DEGREE = 110_574;
const LONGITUDE_METERS_PER_DEGREE = 111_320;
const MINIMUM_LONGITUDE_SCALE = 0.01;

export interface SpatialBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ClosestSegmentPoints {
  distanceMeters: number;
  firstPosition: Position;
  secondPosition: Position;
  firstFraction: number;
  secondFraction: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

export const segmentBounds = (
  start: Position,
  end: Position,
): SpatialBounds => ({
  minX: Math.min(start[0]!, end[0]!),
  minY: Math.min(start[1]!, end[1]!),
  maxX: Math.max(start[0]!, end[0]!),
  maxY: Math.max(start[1]!, end[1]!),
});

export const expandBoundsByMeters = (
  bounds: SpatialBounds,
  distanceMeters: number,
): SpatialBounds => {
  const latitudeDelta = distanceMeters / LATITUDE_METERS_PER_DEGREE;
  const maximumAbsoluteLatitude = Math.min(
    89.999,
    Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY)),
  );
  const longitudeScale = Math.max(
    MINIMUM_LONGITUDE_SCALE,
    Math.cos(maximumAbsoluteLatitude * DEGREES_TO_RADIANS),
  );
  const longitudeDelta =
    distanceMeters / (LONGITUDE_METERS_PER_DEGREE * longitudeScale);

  return {
    minX: bounds.minX - longitudeDelta,
    minY: bounds.minY - latitudeDelta,
    maxX: bounds.maxX + longitudeDelta,
    maxY: bounds.maxY + latitudeDelta,
  };
};

const interpolatePosition = (
  start: Position,
  end: Position,
  fraction: number,
): Position => [
  start[0]! + (end[0]! - start[0]!) * fraction,
  start[1]! + (end[1]! - start[1]!) * fraction,
];

export const distanceMetersBetweenPositions = (
  first: Position,
  second: Position,
): number => {
  const firstLatitude = first[1]! * DEGREES_TO_RADIANS;
  const secondLatitude = second[1]! * DEGREES_TO_RADIANS;
  const latitudeDelta = secondLatitude - firstLatitude;
  const longitudeDelta =
    (second[0]! - first[0]!) * DEGREES_TO_RADIANS;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.asin(Math.min(1, Math.sqrt(haversine)))
  );
};

const projectedCoordinates = (
  positions: Position[],
): Array<{ x: number; y: number }> => {
  const originLongitude = positions[0]![0]!;
  const originLatitude =
    positions.reduce((sum, position) => sum + position[1]!, 0) /
    positions.length;
  const longitudeScale =
    Math.cos(originLatitude * DEGREES_TO_RADIANS) * EARTH_RADIUS_METERS;
  const latitudeScale = EARTH_RADIUS_METERS;

  return positions.map((position) => ({
    x:
      (position[0]! - originLongitude) *
      DEGREES_TO_RADIANS *
      longitudeScale,
    y:
      (position[1]! - originLatitude) *
      DEGREES_TO_RADIANS *
      latitudeScale,
  }));
};

export const closestPointOnSegment = (
  position: Position,
  segmentStart: Position,
  segmentEnd: Position,
): { position: Position; fraction: number; distanceMeters: number } => {
  const [point, start, end] = projectedCoordinates([
    position,
    segmentStart,
    segmentEnd,
  ]);
  const deltaX = end!.x - start!.x;
  const deltaY = end!.y - start!.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  const fraction =
    lengthSquared <= Number.EPSILON
      ? 0
      : clampUnit(
          ((point!.x - start!.x) * deltaX +
            (point!.y - start!.y) * deltaY) /
            lengthSquared,
        );
  const nearestPosition = interpolatePosition(
    segmentStart,
    segmentEnd,
    fraction,
  );
  return {
    position: nearestPosition,
    fraction,
    distanceMeters: distanceMetersBetweenPositions(position, nearestPosition),
  };
};

export const closestPointsBetweenSegments = (
  firstStart: Position,
  firstEnd: Position,
  secondStart: Position,
  secondEnd: Position,
): ClosestSegmentPoints => {
  const [firstStartPoint, firstEndPoint, secondStartPoint, secondEndPoint] =
    projectedCoordinates([firstStart, firstEnd, secondStart, secondEnd]);
  const firstVector = {
    x: firstEndPoint!.x - firstStartPoint!.x,
    y: firstEndPoint!.y - firstStartPoint!.y,
  };
  const secondVector = {
    x: secondEndPoint!.x - secondStartPoint!.x,
    y: secondEndPoint!.y - secondStartPoint!.y,
  };
  const separation = {
    x: firstStartPoint!.x - secondStartPoint!.x,
    y: firstStartPoint!.y - secondStartPoint!.y,
  };
  const firstLengthSquared =
    firstVector.x ** 2 + firstVector.y ** 2;
  const crossLength =
    firstVector.x * secondVector.x + firstVector.y * secondVector.y;
  const secondLengthSquared =
    secondVector.x ** 2 + secondVector.y ** 2;
  const firstProjection =
    firstVector.x * separation.x + firstVector.y * separation.y;
  const secondProjection =
    secondVector.x * separation.x + secondVector.y * separation.y;
  const denominator =
    firstLengthSquared * secondLengthSquared - crossLength ** 2;
  const denominatorTolerance =
    Number.EPSILON *
    Math.max(
      Math.abs(firstLengthSquared * secondLengthSquared),
      Math.abs(crossLength ** 2),
      Number.MIN_VALUE,
    ) *
    64;

  let firstNumerator = 0;
  let firstDenominator = denominator;
  let secondNumerator = 0;
  let secondDenominator = denominator;

  if (denominator <= denominatorTolerance) {
    firstNumerator = 0;
    firstDenominator = 1;
    secondNumerator = secondProjection;
    secondDenominator = secondLengthSquared;
  } else {
    firstNumerator =
      crossLength * secondProjection -
      secondLengthSquared * firstProjection;
    secondNumerator =
      firstLengthSquared * secondProjection -
      crossLength * firstProjection;
    if (firstNumerator < 0) {
      firstNumerator = 0;
      secondNumerator = secondProjection;
      secondDenominator = secondLengthSquared;
    } else if (firstNumerator > firstDenominator) {
      firstNumerator = firstDenominator;
      secondNumerator = secondProjection + crossLength;
      secondDenominator = secondLengthSquared;
    }
  }

  if (secondNumerator < 0) {
    secondNumerator = 0;
    if (-firstProjection < 0) {
      firstNumerator = 0;
    } else if (-firstProjection > firstLengthSquared) {
      firstNumerator = firstDenominator;
    } else {
      firstNumerator = -firstProjection;
      firstDenominator = firstLengthSquared;
    }
  } else if (secondNumerator > secondDenominator) {
    secondNumerator = secondDenominator;
    const shiftedProjection = -firstProjection + crossLength;
    if (shiftedProjection < 0) {
      firstNumerator = 0;
    } else if (shiftedProjection > firstLengthSquared) {
      firstNumerator = firstDenominator;
    } else {
      firstNumerator = shiftedProjection;
      firstDenominator = firstLengthSquared;
    }
  }

  const firstNumeratorTolerance =
    Number.EPSILON *
    Math.max(Math.abs(firstDenominator), Number.MIN_VALUE) *
    64;
  const secondNumeratorTolerance =
    Number.EPSILON *
    Math.max(Math.abs(secondDenominator), Number.MIN_VALUE) *
    64;
  const firstFraction =
    Math.abs(firstNumerator) <= firstNumeratorTolerance
      ? 0
      : clampUnit(firstNumerator / firstDenominator);
  const secondFraction =
    Math.abs(secondNumerator) <= secondNumeratorTolerance
      ? 0
      : clampUnit(secondNumerator / secondDenominator);
  const firstPosition = interpolatePosition(
    firstStart,
    firstEnd,
    firstFraction,
  );
  const secondPosition = interpolatePosition(
    secondStart,
    secondEnd,
    secondFraction,
  );

  return {
    distanceMeters: distanceMetersBetweenPositions(
      firstPosition,
      secondPosition,
    ),
    firstPosition,
    secondPosition,
    firstFraction,
    secondFraction,
  };
};

const cross = (
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
): number => firstX * secondY - firstY * secondX;

export const segmentIntersection = (
  firstStart: Position,
  firstEnd: Position,
  secondStart: Position,
  secondEnd: Position,
): { position: Position; firstFraction: number; secondFraction: number } | null => {
  const firstDeltaX = firstEnd[0]! - firstStart[0]!;
  const firstDeltaY = firstEnd[1]! - firstStart[1]!;
  const secondDeltaX = secondEnd[0]! - secondStart[0]!;
  const secondDeltaY = secondEnd[1]! - secondStart[1]!;
  const startDeltaX = secondStart[0]! - firstStart[0]!;
  const startDeltaY = secondStart[1]! - firstStart[1]!;
  const denominator = cross(
    firstDeltaX,
    firstDeltaY,
    secondDeltaX,
    secondDeltaY,
  );
  const denominatorScale = Math.max(
    Math.abs(firstDeltaX * secondDeltaY),
    Math.abs(firstDeltaY * secondDeltaX),
    Number.MIN_VALUE,
  );
  if (
    Math.abs(denominator) <=
    Number.EPSILON * denominatorScale * 64
  ) {
    return null;
  }

  const firstFraction =
    cross(startDeltaX, startDeltaY, secondDeltaX, secondDeltaY) /
    denominator;
  const secondFraction =
    cross(startDeltaX, startDeltaY, firstDeltaX, firstDeltaY) /
    denominator;
  const epsilon = Number.EPSILON * 128;
  if (
    firstFraction < -epsilon ||
    firstFraction > 1 + epsilon ||
    secondFraction < -epsilon ||
    secondFraction > 1 + epsilon
  ) {
    return null;
  }

  const boundedFirstFraction = clampUnit(firstFraction);
  return {
    position: interpolatePosition(
      firstStart,
      firstEnd,
      boundedFirstFraction,
    ),
    firstFraction: boundedFirstFraction,
    secondFraction: clampUnit(secondFraction),
  };
};
