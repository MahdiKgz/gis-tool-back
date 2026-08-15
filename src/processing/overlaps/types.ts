import { FeatureCollectionLike } from "../shared/geojson";

export interface PolygonOverlapFinding {
  code: "POLYGON_OVERLAP";
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
  overlapAreaM2: number;
  overlapRatio: number;
  overlapBbox: [number, number, number, number];
  repairable: false;
}

export interface PolygonOverlapDetectionResult {
  polygonComponentsScanned: number;
  candidatePairsChecked: number;
  findings: PolygonOverlapFinding[];
}

export interface PolygonOverlapValidationReport {
  valid: boolean;
  polygonComponentsScanned: number;
  candidatePairsChecked: number;
  overlapsFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    PolygonOverlapFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface PolygonOverlapProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: PolygonOverlapValidationReport;
}

export type { FeatureCollectionLike };
