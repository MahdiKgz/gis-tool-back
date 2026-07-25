import { FeatureCollectionLike } from "../shared/geojson";

export interface PolygonAreaBaselineEntry {
  key: string;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  areaM2: number;
}

export interface PolygonAreaBaseline {
  entries: PolygonAreaBaselineEntry[];
}

export interface CollapsedPolygonFinding {
  code: "COLLAPSED_POLYGON";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  beforeAreaM2: number;
  afterAreaM2: number | null;
  collapseKind: "ZeroArea" | "Missing";
  repairable: false;
}

export interface CollapsedPolygonDetectionResult {
  baselinePolygonsScanned: number;
  findings: CollapsedPolygonFinding[];
}

export interface CollapsedPolygonValidationReport {
  valid: boolean;
  baselinePolygonsScanned: number;
  collapsedPolygonsFound: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    CollapsedPolygonFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface CollapsedPolygonProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: CollapsedPolygonValidationReport;
}

export type { FeatureCollectionLike };
