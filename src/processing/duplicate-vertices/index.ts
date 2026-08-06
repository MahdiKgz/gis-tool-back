import { detectDuplicateVertices } from "./detector";
import { repairDuplicateVertices } from "./repair";
import { buildDuplicateVertexReport } from "./report";
import {
  DuplicateVertexProcessResult,
  FeatureCollectionLike,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processDuplicateVertices = <T extends FeatureCollectionLike>(
  geojson: T,
  autoRepair = true,
): DuplicateVertexProcessResult<T> => {
  const findings = detectDuplicateVertices(geojson);
  const repairResult = autoRepair
    ? repairDuplicateVertices(geojson, findings)
    : { geojson, removedCount: 0 };

  return {
    geojson: repairResult.geojson,
    report: buildDuplicateVertexReport(findings, repairResult.removedCount),
  };
};
