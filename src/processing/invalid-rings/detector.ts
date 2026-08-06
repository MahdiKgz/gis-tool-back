import {
  isFinitePosition,
  positionKey,
  positionsEqual,
} from "../shared/coordinates";
import { visitRingCandidates } from "./ring-candidates";
import {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
  InvalidRingDetectionResult,
  InvalidRingFinding,
  RingCandidate,
  RingCorruptionReason,
} from "./types";

const featureId = (
  feature: GeoJsonFeatureLike,
): string | number | null => {
  if (feature.id !== undefined) return feature.id;
  const propertyId = feature.properties?.id;
  return typeof propertyId === "string" || typeof propertyId === "number"
    ? propertyId
    : null;
};

const baseFinding = (
  candidate: RingCandidate,
  feature: GeoJsonFeatureLike,
  featureIndex: number,
  positionCount: number,
  distinctVertexCount: number,
  invalidCoordinateIndices: number[],
  corruptionReason: RingCorruptionReason | null,
) => ({
  featureIndex,
  featureId: featureId(feature),
  geometryType: candidate.geometryType,
  geometryCollectionPath: [...candidate.geometryCollectionPath],
  coordinatePath: [...candidate.coordinatePath],
  role: candidate.role,
  positionCount,
  distinctVertexCount,
  invalidCoordinateIndices,
  corruptionReason,
});

export const detectInvalidRings = (
  geojson: FeatureCollectionLike,
): InvalidRingDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { ringsScanned: 0, findings: [] };
  }

  const findings: InvalidRingFinding[] = [];
  let ringsScanned = 0;

  geojson.features.forEach((feature, featureIndex) => {
    visitRingCandidates(feature.geometry, (candidate) => {
      ringsScanned++;
      const ring = candidate.ring;
      const ringIsArray = Array.isArray(ring);
      const positions = ringIsArray ? ring.filter(isFinitePosition) : [];
      const invalidCoordinateIndices = ringIsArray
        ? ring.flatMap((position, index) =>
            isFinitePosition(position) ? [] : [index],
          )
        : [];

      let corruptionReason: RingCorruptionReason | null = null;
      if (!ringIsArray) corruptionReason = "RING_NOT_ARRAY";
      else if (ring.length === 0) corruptionReason = "EMPTY_RING";
      else if (invalidCoordinateIndices.length > 0)
        corruptionReason = "INVALID_POSITION";

      const closed =
        corruptionReason === null &&
        positions.length > 0 &&
        positionsEqual(positions[0]!, positions[positions.length - 1]!);
      const vertexPositions = closed ? positions.slice(0, -1) : positions;
      const distinctVertexCount = new Set(
        vertexPositions.map(positionKey),
      ).size;
      const base = baseFinding(
        candidate,
        feature,
        featureIndex,
        ringIsArray ? ring.length : 0,
        distinctVertexCount,
        invalidCoordinateIndices,
        corruptionReason,
      );

      if (corruptionReason !== null) {
        findings.push({
          ...base,
          code: "CORRUPTED_RING",
          type: "corrupted",
          repairable: false,
        });
      }

      if (
        corruptionReason === null &&
        positions.length > 0 &&
        !closed
      ) {
        findings.push({
          ...base,
          code: "UNCLOSED_RING",
          type: "unclosed",
          repairable: distinctVertexCount >= 3,
        });
      }

      if (distinctVertexCount < 3) {
        findings.push({
          ...base,
          code: "INSUFFICIENT_RING_VERTICES",
          type: "insufficient-vertices",
          repairable: false,
        });
      }
    });
  });

  return { ringsScanned, findings };
};
