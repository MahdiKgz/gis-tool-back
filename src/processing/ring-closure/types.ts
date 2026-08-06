import { FeatureCollectionLike } from "../shared/geojson";
import { RingRole } from "../shared/polygon-rings";

export type RingClosureBlockedReason =
  | "CORRUPTED_RING"
  | "INSUFFICIENT_VERTICES";

export interface OpenRingFinding {
  code: "OPEN_RING";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  coordinatePath: number[];
  role: RingRole;
  positionCount: number;
  distinctVertexCount: number;
  invalidCoordinateIndices: number[];
  repairable: boolean;
  blockedReason: RingClosureBlockedReason | null;
}

export interface RingClosureIssue extends OpenRingFinding {
  status: "Closed" | "Unresolved";
  recommendedAction: "None" | "ManualReview";
}

export interface RingClosureDetectionResult {
  ringsScanned: number;
  findings: OpenRingFinding[];
}

export interface RingClosureValidationReport {
  valid: boolean;
  ringsScanned: number;
  openRingsFound: number;
  ringsClosed: number;
  unresolvedOpenRings: number;
  unresolvedFeatureIndexes: number[];
  issues: RingClosureIssue[];
}

export interface RingClosureProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: RingClosureValidationReport;
}

export type { FeatureCollectionLike };
