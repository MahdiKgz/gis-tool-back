import { Position } from "../shared/coordinates";
import { FeatureCollectionLike } from "../shared/geojson";

export type SelfIntersectionKind = "Crossing" | "Touching" | "Overlapping";

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
  repairable: false;
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
  unresolvedIssues: number;
  unresolvedFeatureIndexes: number[];
  issues: Array<
    SelfIntersectionFinding & {
      status: "Unresolved";
      recommendedAction: "ManualReview";
    }
  >;
}

export interface SelfIntersectionProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: SelfIntersectionValidationReport;
}

export type { FeatureCollectionLike };
