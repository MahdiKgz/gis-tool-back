import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import lineIntersect from "@turf/line-intersect";
import { lineString, point, polygon } from "@turf/helpers";
import RBush from "rbush";
import { Position, positionsEqual } from "../shared/coordinates";

export interface RingBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RingContainment {
  outside: boolean;
  touching: boolean;
  strictlyInside: boolean;
}

export const ringBounds = (ring: Position[]): RingBounds => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const position of ring) {
    minX = Math.min(minX, position[0]!);
    minY = Math.min(minY, position[1]!);
    maxX = Math.max(maxX, position[0]!);
    maxY = Math.max(maxY, position[1]!);
  }
  return { minX, minY, maxX, maxY };
};

export const boundsContain = (
  outer: RingBounds,
  inner: RingBounds,
): boolean =>
  outer.minX <= inner.minX &&
  outer.minY <= inner.minY &&
  outer.maxX >= inner.maxX &&
  outer.maxY >= inner.maxY;

interface IndexedSegment extends RingBounds {
  index: number;
  start: Position;
  end: Position;
}

const interpolationParameter = (
  position: Position,
  start: Position,
  end: Position,
): number | null => {
  const deltaX = end[0]! - start[0]!;
  const deltaY = end[1]! - start[1]!;
  const useX = Math.abs(deltaX) >= Math.abs(deltaY);
  const denominator = useX ? deltaX : deltaY;
  if (denominator === 0) return null;

  const numerator = useX
    ? position[0]! - start[0]!
    : position[1]! - start[1]!;
  const parameter = numerator / denominator;
  const expectedX = start[0]! + parameter * deltaX;
  const expectedY = start[1]! + parameter * deltaY;
  const scale = Math.max(
    1,
    Math.abs(expectedX),
    Math.abs(expectedY),
    Math.abs(position[0]!),
    Math.abs(position[1]!),
  );
  const tolerance = Number.EPSILON * scale * 64;

  if (
    parameter < -tolerance ||
    parameter > 1 + tolerance ||
    Math.abs(expectedX - position[0]!) > tolerance ||
    Math.abs(expectedY - position[1]!) > tolerance
  ) {
    return null;
  }
  return Math.max(0, Math.min(1, parameter));
};

const segmentBounds = (
  start: Position,
  end: Position,
  index: number,
): IndexedSegment => ({
  minX: Math.min(start[0]!, end[0]!),
  minY: Math.min(start[1]!, end[1]!),
  maxX: Math.max(start[0]!, end[0]!),
  maxY: Math.max(start[1]!, end[1]!),
  index,
  start,
  end,
});

const hasOutsideSegmentInterval = (
  innerRing: Position[],
  outerPolygon: ReturnType<typeof polygon>,
  intersectionPositions: Position[],
): boolean => {
  const segmentIndex = new RBush<IndexedSegment>();
  segmentIndex.load(
    innerRing.slice(0, -1).map((start, index) =>
      segmentBounds(start, innerRing[index + 1]!, index),
    ),
  );
  const parametersBySegment = new Map<number, number[]>();

  for (const position of intersectionPositions) {
    const scale = Math.max(
      1,
      Math.abs(position[0]!),
      Math.abs(position[1]!),
    );
    const tolerance = Number.EPSILON * scale * 64;
    const candidates = segmentIndex.search({
      minX: position[0]! - tolerance,
      minY: position[1]! - tolerance,
      maxX: position[0]! + tolerance,
      maxY: position[1]! + tolerance,
    });

    for (const segment of candidates) {
      const parameter = interpolationParameter(
        position,
        segment.start,
        segment.end,
      );
      if (parameter === null) continue;
      const parameters = parametersBySegment.get(segment.index) ?? [0, 1];
      parameters.push(parameter);
      parametersBySegment.set(segment.index, parameters);
    }
  }

  for (const [segmentIndexValue, parameters] of parametersBySegment) {
    parameters.sort((first, second) => first - second);
    const start = innerRing[segmentIndexValue]!;
    const end = innerRing[segmentIndexValue + 1]!;

    for (let index = 1; index < parameters.length; index++) {
      const first = parameters[index - 1]!;
      const second = parameters[index]!;
      if (second - first <= Number.EPSILON * 64) continue;
      const midpoint = (first + second) / 2;
      const sample = point([
        start[0]! + midpoint * (end[0]! - start[0]!),
        start[1]! + midpoint * (end[1]! - start[1]!),
      ]);
      if (!booleanPointInPolygon(sample, outerPolygon)) return true;
    }
  }

  return false;
};

export const classifyRingContainment = (
  innerRing: Position[],
  outerRing: Position[],
): RingContainment => {
  const outerPolygon = polygon([outerRing] as any);
  const innerVertices = positionsEqual(
    innerRing[0]!,
    innerRing[innerRing.length - 1]!,
  )
    ? innerRing.slice(0, -1)
    : innerRing;

  let outside = false;
  let boundaryContact = false;

  for (const position of innerVertices) {
    const coordinate = point(position);
    const inclusive = booleanPointInPolygon(coordinate, outerPolygon);
    if (!inclusive) {
      outside = true;
      continue;
    }
    if (
      !booleanPointInPolygon(coordinate, outerPolygon, {
        ignoreBoundary: true,
      })
    ) {
      boundaryContact = true;
    }
  }

  const intersections = lineIntersect(
    lineString(innerRing as any),
    lineString(outerRing as any),
  );
  const intersectionPositions = intersections.features.map(
    (intersection) => intersection.geometry.coordinates,
  );
  for (const intersectionPosition of intersectionPositions) {
    boundaryContact = true;
  }
  if (
    !outside &&
    intersectionPositions.length > 0 &&
    hasOutsideSegmentInterval(
      innerRing,
      outerPolygon,
      intersectionPositions,
    )
  ) {
    outside = true;
  }

  return {
    outside,
    touching: !outside && boundaryContact,
    strictlyInside: !outside && !boundaryContact,
  };
};
