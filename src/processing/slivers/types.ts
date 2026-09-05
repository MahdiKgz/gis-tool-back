import { FeatureCollectionLike } from "../shared/geojson";

export interface SliverOptions {
  sliverAreaThresholdM2: number;
  minCompactness?: number;
  minDominantSharedBoundaryRatio?: number;
  minSharedBoundaryDominanceRatio?: number;
  minAbsorptionTargetAreaRatio?: number;
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
  absorptionTargetFeatureIndex: number | null;
  absorptionTargetFeatureId: string | number | null;
  dominantSharedBoundaryLengthMeters: number;
  dominantSharedBoundaryRatio: number;
  sharedBoundaryDominanceRatio: number | null;
  absorptionTargetAreaRatio: number | null;
  repairable: boolean;
}

export interface SliverDetectionResult {
  polygonFeaturesScanned: number;
  findings: SliverFinding[];
}

export type SliverRepairFailureReason =
  | "StaleTarget"
  | "InvalidRepairOutput";

export interface SliverValidationReport {
  valid: boolean;
  polygonFeaturesScanned: number;
  sliversFound: number;
  sliversRemoved: number;
  sliversAbsorbed: number;
  sliversDeleted: number;
  unresolvedSlivers: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedSliverAreaThresholdM2: number;
  issues: Array<
    SliverFinding & {
      status: "Absorbed" | "Removed" | "Unresolved";
      recommendedAction: "None" | "AutoRepair" | "ManualReview";
      repairFailureReason: SliverRepairFailureReason | null;
    }
  >;
}

export interface SliverProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: SliverValidationReport;
}

export type { FeatureCollectionLike };
