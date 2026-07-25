import {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
} from "../shared/geojson";
import { Position } from "../shared/coordinates";
import {
  CoordinateSequence,
  SequenceKind,
} from "../shared/coordinate-sequences";

export type DuplicateVertexKind = "consecutive" | "non-consecutive";

export type {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
  Position,
  CoordinateSequence,
  SequenceKind,
};

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
