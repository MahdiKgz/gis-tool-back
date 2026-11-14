import { Position } from "../shared/coordinates";
import { FeatureCollectionLike } from "../shared/geojson";

export interface NeighborConsistencyOptions {
  coincidenceToleranceMeters?: number;
}

export interface NeighborConsistencyFinding {
  code: "NEIGHBOR_VERTEX_MISMATCH";
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
  vertexPosition: Position;
  insertionPosition: Position;
  targetSegmentStart: Position;
  targetSegmentEnd: Position;
  targetSegmentFraction: number;
  offsetMeters: number;
  candidateTargetCount: number;
  repairable: boolean;
}

export interface NeighborConsistencyDetectionResult {
  polygonComponentsScanned: number;
  verticesScanned: number;
  candidateSegmentsChecked: number;
  findings: NeighborConsistencyFinding[];
}

export type NeighborConsistencyRepairFailureReason =
  | "StaleTarget"
  | "InvalidRepairOutput";

export interface NeighborConsistencyValidationReport {
  valid: boolean;
  polygonComponentsScanned: number;
  verticesScanned: number;
  candidateSegmentsChecked: number;
  mismatchesFound: number;
  verticesInserted: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  appliedCoincidenceToleranceMeters: number;
  issues: Array<
    NeighborConsistencyFinding & {
      status: "Repaired" | "Unresolved";
      recommendedAction: "None" | "AutoRepair" | "ManualReview";
      repairFailureReason: NeighborConsistencyRepairFailureReason | null;
    }
  >;
}

export interface NeighborConsistencyProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: NeighborConsistencyValidationReport;
}

export type { FeatureCollectionLike };
