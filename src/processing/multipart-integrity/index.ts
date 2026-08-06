import { detectMultipartIntegrity } from "./detector";
import { buildMultipartIntegrityReport } from "./report";
import {
  FeatureCollectionLike,
  MultipartIntegrityProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processMultipartIntegrity = <T extends FeatureCollectionLike>(
  geojson: T,
): MultipartIntegrityProcessResult<T> => {
  const detection = detectMultipartIntegrity(geojson);
  return {
    geojson,
    report: buildMultipartIntegrityReport(detection),
  };
};
