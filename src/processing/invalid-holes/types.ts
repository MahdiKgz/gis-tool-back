import { Position } from "../shared/coordinates";
import { FeatureCollectionLike } from "../shared/geojson";

export type InvalidHoleType =
  | "outside"
  | "nested"
  | "duplicate"
  | "self-intersecting"
  | "touching-boundary"
  | "tiny"
  | "larger-than-polygon";

export interface HoleCandidate {
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  coordinatePath: number[];
  exteriorRing: Position[];
  ring: Position[];
}

export interface InvalidHoleFinding {
  code:
    | "HOLE_OUTSIDE_POLYGON"
    | "NESTED_HOLE"
    | "DUPLICATE_HOLE"
    | "SELF_INTERSECTING_HOLE"
    | "HOLE_TOUCHING_BOUNDARY"
    | "TINY_HOLE"
    | "HOLE_LARGER_THAN_POLYGON";
  type: InvalidHoleType;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  coordinatePath: number[];
  relatedHoleCoordinatePath: number[] | null;
  holeSignature: string;
  holeAreaM2: number | null;
  exteriorAreaM2: number | null;
  repairable: boolean;
  recommendedRepair: "Remove" | "ManualReview";
}

export interface InvalidHoleIssue extends InvalidHoleFinding {
  status: "Removed" | "Unresolved";
  recommendedAction: "None" | "ManualReview";
}

export interface InvalidHoleOptions {
  tinyHoleAreaM2: number;
}

export interface InvalidHoleDetectionResult {
  holesScanned: number;
  findings: InvalidHoleFinding[];
}

export interface InvalidHoleValidationReport {
  valid: boolean;
  holesScanned: number;
  invalidHolesFound: number;
  holesRemoved: number;
  tinyHolesRemoved: number;
  outsideHolesRemoved: number;
  holeOrientationsNormalized: number;
  outsideHoles: number;
  nestedHoles: number;
  duplicateHoles: number;
  selfIntersectingHoles: number;
  touchingBoundaryHoles: number;
  tinyHoles: number;
  holesLargerThanPolygon: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: InvalidHoleIssue[];
}

export interface InvalidHoleProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: InvalidHoleValidationReport;
}

export type { FeatureCollectionLike };
