import {
  DEFAULT_MAX_TIP_ANGLE_DEGREES,
  DEFAULT_SPIKE_BASE_TOLERANCE_M,
  detectSpikes,
} from "./detector";
import { repairSpikes } from "./repair";
import { buildSpikeReport } from "./report";
import {
  FeatureCollectionLike,
  SpikeOptions,
  SpikeProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processSpikes = <T extends FeatureCollectionLike>(
  geojson: T,
  options: SpikeOptions = {
    baseToleranceMeters: DEFAULT_SPIKE_BASE_TOLERANCE_M,
  },
  autoRepair = true,
): SpikeProcessResult<T> => {
  const detection = detectSpikes(geojson, options);
  const attempt = repairSpikes(geojson, detection.findings);
  const repair = autoRepair
    ? attempt
    : { ...attempt, geojson, removedKeys: new Set<string>() };
  return {
    geojson: repair.geojson,
    report: buildSpikeReport(
      detection,
      repair.removedKeys,
      options.baseToleranceMeters,
      options.maxTipAngleDegrees ?? DEFAULT_MAX_TIP_ANGLE_DEGREES,
      repair.failedReasons,
    ),
  };
};
