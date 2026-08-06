import {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
} from "../shared/geojson";
import { Position } from "../shared/coordinates";

export type SequenceKind = "line" | "ring";

export type DuplicateVertexKind = "consecutive" | "non-consecutive";

export type {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
  Position,
};

export interface CoordinateSequence {
  geometryType: string;
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  kind: SequenceKind;
  coordinates: Position[];
}

export interface DuplicateVertexFinding {
  code: "DUPLICATE_VERTEX";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: string;
  geometryCollectionPath: number[];
  coordinatePath: number[];
  duplicateOfCoordinatePath: number[];
  kind: DuplicateVertexKind;
  repairable: boolean;
}

export interface DuplicateVertexIssue extends DuplicateVertexFinding {
  status: "Repaired" | "Unresolved";
  recommendedAction: "None" | "ManualReview";
}

export interface DuplicateVertexValidationReport {
  valid: boolean;
  duplicatesFound: number;
  duplicatesRemoved: number;
  unresolvedDuplicates: number;
  consecutiveDuplicates: number;
  nonConsecutiveDuplicates: number;
  issues: DuplicateVertexIssue[];
}

export interface DuplicateVertexProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: DuplicateVertexValidationReport;
}
