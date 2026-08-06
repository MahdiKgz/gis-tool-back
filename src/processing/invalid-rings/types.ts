import {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
} from "../shared/geojson";
import {
  RingCandidate,
  RingRole,
} from "../shared/polygon-rings";

export type InvalidRingIssueType =
  | "unclosed"
  | "corrupted"
  | "insufficient-vertices";

export type RingCorruptionReason =
  | "RING_NOT_ARRAY"
  | "EMPTY_RING"
  | "INVALID_POSITION";

export interface InvalidRingFinding {
  code:
    | "UNCLOSED_RING"
    | "CORRUPTED_RING"
    | "INSUFFICIENT_RING_VERTICES";
  type: InvalidRingIssueType;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  coordinatePath: number[];
  role: RingRole;
  positionCount: number;
  distinctVertexCount: number;
  invalidCoordinateIndices: number[];
  corruptionReason: RingCorruptionReason | null;
  repairable: boolean;
}

export interface InvalidRingIssue extends InvalidRingFinding {
  status: "Repaired" | "Unresolved";
  recommendedAction: "None" | "ManualReview";
}

export interface InvalidRingValidationReport {
  valid: boolean;
  ringsScanned: number;
  invalidRingsFound: number;
  ringsRepaired: number;
  unclosedRings: number;
  corruptedRings: number;
  insufficientRings: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: InvalidRingIssue[];
}

export interface InvalidRingDetectionResult {
  ringsScanned: number;
  findings: InvalidRingFinding[];
}

export interface InvalidRingProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: InvalidRingValidationReport;
  repairedRingKeys: Set<string>;
}

export type {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
  RingCandidate,
  RingRole,
};
