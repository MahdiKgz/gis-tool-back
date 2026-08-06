import { FeatureCollectionLike } from "../shared/geojson";

export type GeometryDimensionFindingCode =
  | "INVALID_POSITION_DIMENSION"
  | "INCONSISTENT_POSITION_DIMENSION"
  | "INVALID_COORDINATE_VALUE";

export interface GeometryDimensionFinding {
  code: GeometryDimensionFindingCode;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: string;
  geometryCollectionPath: number[];
  coordinatePath: number[];
  expectedDimension: number | null;
  actualDimension: number | null;
  repairable: false;
}

export interface GeometryDimensionDetectionResult {
  positionsScanned: number;
  findings: GeometryDimensionFinding[];
}

export interface GeometryDimensionValidationReport {
  valid: boolean;
  positionsScanned: number;
  invalidDimensionsFound: number;
  inconsistentDimensionsFound: number;
  invalidCoordinateValuesFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    GeometryDimensionFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface GeometryDimensionProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: GeometryDimensionValidationReport;
}

export type { FeatureCollectionLike };
