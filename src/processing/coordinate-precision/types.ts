import { FeatureCollectionLike } from "../shared/geojson";

export interface CoordinatePrecisionOptions {
  maxDecimalPlaces: number;
}

export type CoordinatePrecisionFindingCode =
  | "EXCESSIVE_COORDINATE_PRECISION"
  | "ROUNDING_COLLISION"
  | "UNSAFE_COORDINATE_MAGNITUDE";

export interface CoordinatePrecisionFinding {
  code: CoordinatePrecisionFindingCode;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: string;
  geometryCollectionPath: number[];
  coordinatePath: number[];
  relatedCoordinatePath: number[] | null;
  ordinateIndex: number | null;
  value: number | null;
  roundedValue: number | null;
  decimalPlaces: number | null;
  maxDecimalPlaces: number;
  repairable: false;
}

export interface CoordinatePrecisionDetectionResult {
  positionsScanned: number;
  findings: CoordinatePrecisionFinding[];
}

export interface CoordinatePrecisionValidationReport {
  valid: boolean;
  positionsScanned: number;
  precisionIssuesFound: number;
  excessiveCoordinateValues: number;
  roundingCollisions: number;
  unsafeMagnitudeValues: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedMaxDecimalPlaces: number;
  issues: Array<
    CoordinatePrecisionFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface CoordinatePrecisionProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: CoordinatePrecisionValidationReport;
}

export type { FeatureCollectionLike };
