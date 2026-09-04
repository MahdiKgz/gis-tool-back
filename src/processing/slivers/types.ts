import { FeatureCollectionLike } from "../shared/geojson";

export interface SliverOptions {
  sliverAreaThresholdM2: number;
  minCompactness?: number;
}

export interface SliverFinding {
  code: "SLIVER_POLYGON";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  areaM2: number;
  perimeterMeters: number;
  compactness: number;
  detectionReasons: Array<"Area" | "Compactness">;
  thresholdM2: number;
  minCompactness: number;
  repairable: boolean;
}

export interface SliverDetectionResult {
  polygonFeaturesScanned: number;
  findings: SliverFinding[];
}

export interface SliverValidationReport {
  valid: boolean;
  polygonFeaturesScanned: number;
  sliversFound: number;
  sliversRemoved: number;
  unresolvedSlivers: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedSliverAreaThresholdM2: number;
  issues: Array<
    SliverFinding & {
      status: "Removed" | "Unresolved";
      recommendedAction: "None" | "AutoRepair" | "ManualReview";
    }
  >;
}

export interface SliverProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: SliverValidationReport;
}

export type { FeatureCollectionLike };
