import { Position } from "../shared/coordinates";
import { FeatureCollectionLike } from "../shared/geojson";

export interface GapOptions {
  gapToleranceMeters: number;
  maxInferredGapWidthMeters?: number;
  maxGapWidthToSharedBoundaryRatio?: number;
  minSharedBoundaryRatio?: number;
  maxParallelAngleDegrees?: number;
}

export interface GapFinding {
  code: "POLYGON_GAP";
  featureIndex: number;
  featureId: string | number | null;
  relatedFeatureIndex: number;
  relatedFeatureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  relatedGeometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  relatedGeometryCollectionPath: number[];
  polygonPath: number[];
  relatedPolygonPath: number[];
  coordinatePath: number[];
  relatedCoordinatePath: number[];
  nearestPosition: Position;
  relatedNearestPosition: Position;
  distanceMeters: number;
  toleranceMeters: number;
  detectionMode: "Tolerance" | "SharedBoundaryPattern";
  sharedBoundaryLengthMeters: number | null;
  sharedBoundaryRatio: number | null;
  gapWidthToSharedBoundaryRatio: number | null;
  repairable: boolean;
}

export interface GapDetectionResult {
  polygonComponentsScanned: number;
  candidatePairsChecked: number;
  findings: GapFinding[];
}

export interface GapValidationReport {
  valid: boolean;
  polygonComponentsScanned: number;
  candidatePairsChecked: number;
  gapsFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedGapToleranceMeters: number;
  issues: Array<
    GapFinding & {
      status: "Unresolved";
      recommendedAction: "AutoRepair" | "ManualReview";
    }
  >;
}

export interface GapProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: GapValidationReport;
}

export type { FeatureCollectionLike };
