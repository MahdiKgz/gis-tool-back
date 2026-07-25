export type Position = number[];

export type SequenceKind = "line" | "ring";

export type DuplicateVertexKind = "consecutive" | "non-consecutive";

export interface GeoJsonFeatureLike {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: any;
  [key: string]: unknown;
}

export interface FeatureCollectionLike {
  type?: string;
  features?: GeoJsonFeatureLike[];
  [key: string]: unknown;
}

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
