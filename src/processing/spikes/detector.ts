import distance from "@turf/distance";
import { point } from "@turf/helpers";
import { getFeatureId } from "../shared/feature-id";
import {
  CoordinateSequence,
  visitCoordinateSequences,
} from "../shared/coordinate-sequences";
import { positionsEqual, Position } from "../shared/coordinates";
import { calculateRingOrientation } from "../ring-orientation";
import {
  FeatureCollectionLike,
  SpikeDetectionResult,
  SpikeFinding,
  SpikeOptions,
} from "./types";

export const DEFAULT_SPIKE_BASE_TOLERANCE_M = 0.025;
export const DEFAULT_MAX_TIP_ANGLE_DEGREES = 10;
export const DEFAULT_MIN_LEG_TO_BASE_RATIO = 3;
export const STRONG_RING_SPIKE_MIN_LEG_TO_BASE_RATIO = 10;

const distanceMeters = (first: Position, second: Position): number =>
  distance(point(first), point(second), { units: "meters" });

const angleDegrees = (
  beforeLegMeters: number,
  afterLegMeters: number,
  baseWidthMeters: number,
): number => {
  const denominator = 2 * beforeLegMeters * afterLegMeters;
  if (denominator === 0) return Number.NaN;
  const cosine = Math.max(
    -1,
    Math.min(
      1,
      (beforeLegMeters ** 2 +
        afterLegMeters ** 2 -
        baseWidthMeters ** 2) /
        denominator,
    ),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
};

const openRing = (coordinates: Position[]): Position[] =>
  positionsEqual(coordinates[0]!, coordinates[coordinates.length - 1]!)
    ? coordinates.slice(0, -1)
    : [];

const candidateIndexes = (sequence: CoordinateSequence): number[] => {
  if (sequence.kind === "line") {
    return sequence.coordinates
      .slice(1, -1)
      .map((_, index) => index + 1);
  }
  return openRing(sequence.coordinates).map((_, index) => index);
};

const neighboringPositions = (
  sequence: CoordinateSequence,
  tipIndex: number,
): { previous: Position; tip: Position; next: Position } | null => {
  if (sequence.kind === "line") {
    const previous = sequence.coordinates[tipIndex - 1];
    const tip = sequence.coordinates[tipIndex];
    const next = sequence.coordinates[tipIndex + 1];
    return previous && tip && next ? { previous, tip, next } : null;
  }

  const coordinates = openRing(sequence.coordinates);
  if (coordinates.length < 3) return null;
  return {
    previous: coordinates[(tipIndex - 1 + coordinates.length) % coordinates.length]!,
    tip: coordinates[tipIndex]!,
    next: coordinates[(tipIndex + 1) % coordinates.length]!,
  };
};

const isExteriorRing = (sequence: CoordinateSequence): boolean =>
  sequence.kind === "ring" && sequence.coordinateRootPath.at(-1) === 0;

const isOutwardRingSpike = (
  sequence: CoordinateSequence,
  previous: Position,
  tip: Position,
  next: Position,
): boolean | null => {
  if (!isExteriorRing(sequence)) return null;
  const orientation = calculateRingOrientation(sequence.coordinates);
  if (orientation === "indeterminate") return null;
  const incomingX = tip[0]! - previous[0]!;
  const incomingY = tip[1]! - previous[1]!;
  const outgoingX = next[0]! - tip[0]!;
  const outgoingY = next[1]! - tip[1]!;
  const turn = incomingX * outgoingY - incomingY * outgoingX;
  return orientation === "counterclockwise" ? turn > 0 : turn < 0;
};

const validateOptions = (
  options: SpikeOptions,
): Required<SpikeOptions> => {
  const normalized = {
    baseToleranceMeters: options.baseToleranceMeters,
    maxTipAngleDegrees:
      options.maxTipAngleDegrees ?? DEFAULT_MAX_TIP_ANGLE_DEGREES,
    minLegToBaseRatio:
      options.minLegToBaseRatio ?? DEFAULT_MIN_LEG_TO_BASE_RATIO,
  };
  if (
    !Number.isFinite(normalized.baseToleranceMeters) ||
    normalized.baseToleranceMeters < 0
  ) {
    throw new RangeError(
      "baseToleranceMeters must be a finite non-negative number",
    );
  }
  if (
    !Number.isFinite(normalized.maxTipAngleDegrees) ||
    normalized.maxTipAngleDegrees <= 0 ||
    normalized.maxTipAngleDegrees >= 180
  ) {
    throw new RangeError(
      "maxTipAngleDegrees must be finite and between 0 and 180",
    );
  }
  if (
    !Number.isFinite(normalized.minLegToBaseRatio) ||
    normalized.minLegToBaseRatio < 1
  ) {
    throw new RangeError(
      "minLegToBaseRatio must be a finite number of at least 1",
    );
  }
  return normalized;
};

export const detectSpikes = (
  geojson: FeatureCollectionLike,
  options: SpikeOptions = {
    baseToleranceMeters: DEFAULT_SPIKE_BASE_TOLERANCE_M,
  },
): SpikeDetectionResult => {
  const normalized = validateOptions(options);
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { sequencesScanned: 0, findings: [] };
  }

  let sequencesScanned = 0;
  const findings: SpikeFinding[] = [];
  geojson.features.forEach((feature, featureIndex) => {
    visitCoordinateSequences(feature.geometry, (sequence) => {
      sequencesScanned++;
      for (const tipIndex of candidateIndexes(sequence)) {
        const positions = neighboringPositions(sequence, tipIndex);
        if (!positions) continue;
        const beforeLegMeters = distanceMeters(
          positions.previous,
          positions.tip,
        );
        const afterLegMeters = distanceMeters(
          positions.tip,
          positions.next,
        );
        const baseWidthMeters = distanceMeters(
          positions.previous,
          positions.next,
        );
        const tipAngleDegrees = angleDegrees(
          beforeLegMeters,
          afterLegMeters,
          baseWidthMeters,
        );
        const legToBaseRatio =
          baseWidthMeters === 0
            ? Number.POSITIVE_INFINITY
            : Math.min(beforeLegMeters, afterLegMeters) / baseWidthMeters;
        if (
          !Number.isFinite(tipAngleDegrees) ||
          tipAngleDegrees > normalized.maxTipAngleDegrees ||
          legToBaseRatio < normalized.minLegToBaseRatio
        ) {
          continue;
        }

        const withinTolerance =
          baseWidthMeters <= normalized.baseToleranceMeters;
        // A very narrow ring backtrack is strong shape evidence even when its
        // shoulders are farther apart than the coordinate-movement tolerance.
        // Removing the tip does not move either shoulder, and repair still has
        // to pass the transactional ring-validity boundary in repair.ts.
        const outwardRingSpike = isOutwardRingSpike(
          sequence,
          positions.previous,
          positions.tip,
          positions.next,
        );
        const strongRingBacktrack =
          outwardRingSpike === true &&
          legToBaseRatio >= STRONG_RING_SPIKE_MIN_LEG_TO_BASE_RATIO;

        findings.push({
          code: "SPIKE",
          featureIndex,
          featureId: getFeatureId(feature),
          geometryType: sequence.geometryType,
          geometryCollectionPath: [...sequence.geometryCollectionPath],
          coordinateRootPath: [...sequence.coordinateRootPath],
          coordinatePath: [...sequence.coordinateRootPath, tipIndex],
          sequenceKind: sequence.kind,
          previousPosition: [...positions.previous],
          tipPosition: [...positions.tip],
          nextPosition: [...positions.next],
          baseWidthMeters,
          beforeLegMeters,
          afterLegMeters,
          tipAngleDegrees,
          legToBaseRatio,
          outwardRingSpike,
          repairEvidence: withinTolerance
            ? "WithinTolerance"
            : strongRingBacktrack
              ? "StrongRingBacktrack"
              : "None",
          repairable: withinTolerance || strongRingBacktrack,
        });
      }
    });
  });
  return { sequencesScanned, findings };
};
