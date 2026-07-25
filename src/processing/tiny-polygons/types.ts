import { FeatureCollectionLike } from "../shared/geojson";

export interface TinyPolygonOptions {
  tinyPolygonAreaM2: number;
}

export interface TinyPolygonFinding {
  code: "TINY_POLYGON";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  areaM2: number;
  thresholdM2: number;
  repairable: false;
}

export interface TinyPolygonDetectionResult {
  polygonsScanned: number;
  findings: TinyPolygonFinding[];
}

export interface TinyPolygonValidationReport {
  valid: boolean;
  polygonsScanned: number;
  tinyPolygonsFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedTinyPolygonAreaM2: number;
  issues: Array<
    TinyPolygonFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface TinyPolygonProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: TinyPolygonValidationReport;
}

export type { FeatureCollectionLike };
