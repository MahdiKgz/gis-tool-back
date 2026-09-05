import { detectLineTopology } from "./detector";
import { repairLineTopology } from "./repair";
import { buildLineTopologyReports } from "./report";
import {
  FeatureCollectionLike,
  LineTopologyOptions,
  LineTopologyProcessResult,
} from "./types";
import { GeoJsonFeatureLike } from "../shared/geojson";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processLineTopology = <T extends FeatureCollectionLike>(
  geojson: T,
  options: LineTopologyOptions,
  autoRepair = true,
): LineTopologyProcessResult<T> => {
  const detection = detectLineTopology(geojson, options);
  const attempt = repairLineTopology(geojson, [
    ...detection.overshoots,
    ...detection.undershoots,
  ]);
  const repair = autoRepair
    ? attempt
    : { ...attempt, geojson, repairedKeys: new Set<string>() };
  return {
    geojson: repair.geojson,
    reports: buildLineTopologyReports(
      detection,
      repair.repairedKeys,
      repair.rejectedKeys,
      options.toleranceMeters,
    ),
  };
};

/**
 * Repairs line features while retaining polygon boundaries as read-only
 * topology targets. Returning only the line prefix prevents target polygons
 * from being duplicated when a caller recombines its output collections.
 */
export const processLineTopologyWithPolygonContext = (
  lineFeatures: GeoJsonFeatureLike[],
  polygonFeatures: GeoJsonFeatureLike[],
  options: LineTopologyOptions,
  autoRepair = true,
): LineTopologyProcessResult<FeatureCollectionLike> => {
  const context: FeatureCollectionLike = {
    type: "FeatureCollection",
    features: [...lineFeatures, ...polygonFeatures],
  };
  const result = processLineTopology(context, options, autoRepair);
  return {
    geojson: {
      type: "FeatureCollection",
      features: result.geojson.features?.slice(0, lineFeatures.length) ?? [],
    },
    reports: result.reports,
  };
};
