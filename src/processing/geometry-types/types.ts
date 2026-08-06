import { FeatureCollectionLike } from "../shared/geojson";

export type SupportedGeometryType =
  | "Point"
  | "MultiPoint"
  | "LineString"
  | "MultiLineString"
  | "Polygon"
  | "MultiPolygon"
  | "GeometryCollection";

export type GeometryTypeFindingCode =
  | "INVALID_FEATURE_OBJECT"
  | "INVALID_GEOMETRY_OBJECT"
  | "MISSING_GEOMETRY_TYPE"
  | "UNSUPPORTED_GEOMETRY_TYPE"
  | "INVALID_GEOMETRY_COLLECTION";

export interface GeometryTypeFinding {
  code: GeometryTypeFindingCode;
  featureIndex: number;
  featureId: string | number | null;
  geometryCollectionPath: number[];
  receivedType: string | null;
  repairable: false;
}

export interface GeometryTypeDetectionResult {
  rootValid: boolean;
  rootError: string | null;
  geometriesScanned: number;
  findings: GeometryTypeFinding[];
}

export interface GeometryTypeValidationReport {
  valid: boolean;
  rootValid: boolean;
  rootError: string | null;
  geometriesScanned: number;
  invalidGeometryTypesFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    GeometryTypeFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface GeometryTypeProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: GeometryTypeValidationReport;
}

export type { FeatureCollectionLike };
