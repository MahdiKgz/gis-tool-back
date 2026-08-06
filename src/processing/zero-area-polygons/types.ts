import { FeatureCollectionLike } from "../shared/geojson";

export interface ZeroAreaPolygonFinding {
  code: "ZERO_AREA_POLYGON";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  areaM2: 0;
  repairable: false;
}

export interface ZeroAreaPolygonDetectionResult {
  polygonsScanned: number;
  findings: ZeroAreaPolygonFinding[];
}

export interface ZeroAreaPolygonIssue extends ZeroAreaPolygonFinding {
  status: "Unresolved";
  recommendedAction: "ManualReview";
}

export interface ZeroAreaPolygonValidationReport {
  valid: boolean;
  polygonsScanned: number;
  zeroAreaPolygonsFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: ZeroAreaPolygonIssue[];
}

export interface ZeroAreaPolygonProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: ZeroAreaPolygonValidationReport;
}

export type { FeatureCollectionLike };
