import { FeatureCollectionLike } from "../shared/geojson";
import { RingRole } from "../shared/polygon-rings";
import { RingOrientation } from "./orientation";

export interface RingOrientationFinding {
  code:
    | "INCORRECT_RING_ORIENTATION"
    | "INDETERMINATE_RING_ORIENTATION";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  coordinatePath: number[];
  role: RingRole;
  actualOrientation: RingOrientation;
  expectedOrientation: Exclude<RingOrientation, "indeterminate">;
  repairable: boolean;
}

export interface RingOrientationIssue extends RingOrientationFinding {
  status: "Normalized" | "Unresolved";
  recommendedAction: "None" | "ManualReview";
}

export interface RingOrientationDetectionResult {
  ringsScanned: number;
  ringsEvaluated: number;
  findings: RingOrientationFinding[];
}

export interface RingOrientationValidationReport {
  valid: boolean;
  ringsScanned: number;
  ringsEvaluated: number;
  orientationIssuesFound: number;
  exteriorOrientationIssues: number;
  interiorOrientationIssues: number;
  indeterminateRings: number;
  ringsNormalized: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: RingOrientationIssue[];
}

export interface RingOrientationProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: RingOrientationValidationReport;
}

export type { FeatureCollectionLike, RingOrientation };
