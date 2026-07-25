import {
  isFinitePosition,
  positionKey,
  positionsEqual,
} from "../shared/coordinates";
import { getFeatureId } from "../shared/feature-id";
import { visitRingCandidates } from "../shared/polygon-rings";
import {
  FeatureCollectionLike,
  OpenRingFinding,
  RingClosureDetectionResult,
} from "./types";

export const detectOpenRings = (
  geojson: FeatureCollectionLike,
): RingClosureDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { ringsScanned: 0, findings: [] };
  }

  const findings: OpenRingFinding[] = [];
  let ringsScanned = 0;

  geojson.features.forEach((feature, featureIndex) => {
    visitRingCandidates(feature.geometry, (candidate) => {
      ringsScanned++;
      if (!Array.isArray(candidate.ring) || candidate.ring.length === 0) {
        return;
      }

      const first = candidate.ring[0];
      const last = candidate.ring[candidate.ring.length - 1];
      if (
        !isFinitePosition(first) ||
        !isFinitePosition(last) ||
        positionsEqual(first, last)
      ) {
        return;
      }

      const invalidCoordinateIndices: number[] = [];
      const distinctVertices = new Set<string>();
      candidate.ring.forEach((position, index) => {
        if (isFinitePosition(position)) {
          distinctVertices.add(positionKey(position));
        } else {
          invalidCoordinateIndices.push(index);
        }
      });
      const distinctVertexCount = distinctVertices.size;
      const blockedReason =
        invalidCoordinateIndices.length > 0
          ? ("CORRUPTED_RING" as const)
          : distinctVertexCount < 3
            ? ("INSUFFICIENT_VERTICES" as const)
            : null;

      findings.push({
        code: "OPEN_RING",
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: candidate.geometryType,
        geometryCollectionPath: [...candidate.geometryCollectionPath],
        coordinatePath: [...candidate.coordinatePath],
        role: candidate.role,
        positionCount: candidate.ring.length,
        distinctVertexCount,
        invalidCoordinateIndices,
        repairable: blockedReason === null,
        blockedReason,
      });
    });
  });

  return { ringsScanned, findings };
};
