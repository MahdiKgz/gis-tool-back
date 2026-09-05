import { Position } from "../shared/coordinates";
import { FeatureCollectionLike } from "../shared/geojson";

export type SelfIntersectionKind = "Crossing" | "Touching" | "Overlapping";

export type SelfIntersectionRepairFailureReason =
  | "StaleTarget"
  | "UnsupportedGeometry"
  | "PolygonizationFailed"
  | "InvalidRepairOutput";

export type SelfIntersectionGeometry =
  | {
      type: "Point";
      coordinates: Position;
    }
  | {
      type: "LineString";
      coordinates: [Position, Position];
    };

export interface SelfIntersectionFinding {
  code: "SELF_INTERSECTION";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  coordinatePath: number[];
  relatedCoordinatePath: number[];
  intersectionKind: SelfIntersectionKind;
  intersectionGeometry: SelfIntersectionGeometry;
  firstSegment: [Position, Position];
  secondSegment: [Position, Position];
  repairStrategy: "UnkinkToMultiPolygon" | null;
  repairable: boolean;
}

export interface SelfIntersectionDetectionResult {
  ringsScanned: number;
  segmentsScanned: number;
  findings: SelfIntersectionFinding[];
}

export interface SelfIntersectionValidationReport {
  valid: boolean;
  ringsScanned: number;
  segmentsScanned: number;
  selfIntersectionsFound: number;
  crossingsFound: number;
  touchesFound: number;
  overlapsFound: number;
  selfIntersectionsRepaired: number;
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    SelfIntersectionFinding & {
      status: "Repaired" | "Unresolved";
      recommendedAction: "None" | "AutoRepair" | "ManualReview";
      repairFailureReason: SelfIntersectionRepairFailureReason | null;
    }
  >;
}

export interface SelfIntersectionProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: SelfIntersectionValidationReport;
}

export type { FeatureCollectionLike };
