import { isFinitePosition, positionsEqual } from "../shared/coordinates";
import { getFeatureId } from "../shared/feature-id";
import { visitRingCandidates } from "../shared/polygon-rings";
import { calculateRingOrientation } from "./orientation";
import {
  FeatureCollectionLike,
  RingOrientationDetectionResult,
  RingOrientationFinding,
} from "./types";

export const detectRingOrientationIssues = (
  geojson: FeatureCollectionLike,
): RingOrientationDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { ringsScanned: 0, ringsEvaluated: 0, findings: [] };
  }

  const findings: RingOrientationFinding[] = [];
  let ringsScanned = 0;
  let ringsEvaluated = 0;

  geojson.features.forEach((feature, featureIndex) => {
    visitRingCandidates(feature.geometry, (candidate) => {
      ringsScanned++;
      const ring = candidate.ring;
      if (
        !Array.isArray(ring) ||
        ring.length < 4 ||
        !ring.every(isFinitePosition) ||
        !positionsEqual(ring[0]!, ring[ring.length - 1]!)
      ) {
        return;
      }

      ringsEvaluated++;
      const actualOrientation = calculateRingOrientation(ring);
      const expectedOrientation =
        candidate.role === "exterior"
          ? ("counterclockwise" as const)
          : ("clockwise" as const);

      if (actualOrientation === expectedOrientation) return;

      findings.push({
        code:
          actualOrientation === "indeterminate"
            ? "INDETERMINATE_RING_ORIENTATION"
            : "INCORRECT_RING_ORIENTATION",
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: candidate.geometryType,
        geometryCollectionPath: [...candidate.geometryCollectionPath],
        coordinatePath: [...candidate.coordinatePath],
        role: candidate.role,
        actualOrientation,
        expectedOrientation,
        repairable: actualOrientation !== "indeterminate",
      });
    });
  });

  return { ringsScanned, ringsEvaluated, findings };
};
