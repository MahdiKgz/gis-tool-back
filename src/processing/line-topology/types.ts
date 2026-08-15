import { Position } from "../shared/coordinates";
import { FeatureCollectionLike } from "../shared/geojson";

export interface LineTopologyOptions {
  toleranceMeters: number;
}

interface LineEndpointFinding {
  featureIndex: number;
  featureId: string | number | null;
  relatedFeatureIndex: number;
  relatedFeatureId: string | number | null;
  geometryType: string;
  relatedGeometryType: string;
  geometryCollectionPath: number[];
  relatedGeometryCollectionPath: number[];
  coordinateRootPath: number[];
  relatedCoordinateRootPath: number[];
  coordinatePath: number[];
  relatedCoordinatePath: number[];
  endpoint: "start" | "end";
  endpointPosition: Position;
  targetPosition: Position;
  distanceMeters: number;
  toleranceMeters: number;
  repairable: boolean;
}

export interface UndershootFinding extends LineEndpointFinding {
  code: "LINE_UNDERSHOOT";
  relatedSegmentIndex: number;
}

export interface OvershootFinding extends LineEndpointFinding {
  code: "LINE_OVERSHOOT";
  sourceSegmentIndex: number;
  relatedSegmentIndex: number;
  overrunDistanceMeters: number;
}

export type LineTopologyFinding = UndershootFinding | OvershootFinding;

export interface LineTopologyDetectionResult {
  linePartsScanned: number;
  undershoots: UndershootFinding[];
  overshoots: OvershootFinding[];
}

export interface LineTopologyIssueBase {
  status: "Repaired" | "Unresolved";
  recommendedAction: "None" | "AutoRepair" | "ManualReview";
}

export interface UndershootValidationReport {
  valid: boolean;
  linePartsScanned: number;
  undershootsFound: number;
  undershootsRepaired: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedToleranceMeters: number;
  issues: Array<UndershootFinding & LineTopologyIssueBase>;
}

export interface OvershootValidationReport {
  valid: boolean;
  linePartsScanned: number;
  overshootsFound: number;
  overshootsRepaired: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedToleranceMeters: number;
  issues: Array<OvershootFinding & LineTopologyIssueBase>;
}

export interface LineTopologyProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  reports: {
    undershoots: UndershootValidationReport;
    overshoots: OvershootValidationReport;
  };
}

export type { FeatureCollectionLike };
