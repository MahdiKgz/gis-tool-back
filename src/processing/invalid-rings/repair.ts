import { closeRingTargets } from "../ring-closure/repair";
import {
  FeatureCollectionLike,
  InvalidRingFinding,
} from "./types";

export interface InvalidRingRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedRingKeys: Set<string>;
}

export const repairInvalidRings = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: InvalidRingFinding[],
): InvalidRingRepairResult<T> => {
  const repairable = findings.filter(
    (finding) => finding.type === "unclosed" && finding.repairable,
  );
  const result = closeRingTargets(geojson, repairable);

  return {
    geojson: result.geojson,
    repairedRingKeys: result.closedRingKeys,
  };
};
