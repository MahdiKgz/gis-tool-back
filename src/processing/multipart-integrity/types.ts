import { FeatureCollectionLike } from "../shared/geojson";

export type MultipartIntegrityFindingCode =
  | "EMPTY_MULTIPOLYGON"
  | "INVALID_POLYGON_COMPONENT"
  | "DUPLICATE_POLYGON_COMPONENT"
  | "OVERLAPPING_POLYGON_COMPONENTS";

export interface MultipartIntegrityFinding {
  code: MultipartIntegrityFindingCode;
  featureIndex: number;
  featureId: string | number | null;
  geometryCollectionPath: number[];
  polygonPath: number[] | null;
  relatedPolygonPath: number[] | null;
  overlapAreaM2: number | null;
  repairable: false;
}

export interface MultipartIntegrityDetectionResult {
  multiPolygonsScanned: number;
  polygonComponentsScanned: number;
  findings: MultipartIntegrityFinding[];
}

export interface MultipartIntegrityValidationReport {
  valid: boolean;
  multiPolygonsScanned: number;
  polygonComponentsScanned: number;
  invalidMultiPolygonsFound: number;
  emptyMultiPolygons: number;
  invalidPolygonComponents: number;
  duplicatePolygonComponents: number;
  overlappingPolygonComponents: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    MultipartIntegrityFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface MultipartIntegrityProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: MultipartIntegrityValidationReport;
}

export type { FeatureCollectionLike };
