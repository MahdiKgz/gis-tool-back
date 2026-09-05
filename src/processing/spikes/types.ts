import { Position } from "../shared/coordinates";
import {
  FeatureCollectionLike,
} from "../shared/geojson";
import { SequenceKind } from "../shared/coordinate-sequences";

export interface SpikeOptions {
  baseToleranceMeters: number;
  maxTipAngleDegrees?: number;
  minLegToBaseRatio?: number;
}

export interface SpikeFinding {
  code: "SPIKE";
  featureIndex: number;
  featureId: string | number | null;
  geometryType: string;
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  coordinatePath: number[];
  sequenceKind: SequenceKind;
  previousPosition: Position;
  tipPosition: Position;
  nextPosition: Position;
  baseWidthMeters: number;
  beforeLegMeters: number;
  afterLegMeters: number;
  tipAngleDegrees: number;
  legToBaseRatio: number;
  outwardRingSpike: boolean | null;
  repairEvidence: "WithinTolerance" | "StrongRingBacktrack" | "None";
  repairable: boolean;
}

export interface SpikeDetectionResult {
  sequencesScanned: number;
  findings: SpikeFinding[];
}

export type SpikeRepairFailureReason = "StaleTarget" | "InvalidRepairOutput";

export interface SpikeIssue extends SpikeFinding {
  status: "Removed" | "Unresolved";
  recommendedAction: "None" | "AutoRepair" | "ManualReview";
  repairFailureReason: SpikeRepairFailureReason | null;
}

export interface SpikeValidationReport {
  valid: boolean;
  sequencesScanned: number;
  spikesFound: number;
  spikesRemoved: number;
  unresolvedSpikes: number;
  unresolvedFeatureIndexes: number[];
  appliedBaseToleranceMeters: number;
  appliedMaxTipAngleDegrees: number;
  issues: SpikeIssue[];
}

export interface SpikeProcessResult<T = FeatureCollectionLike> {
  geojson: T;
  report: SpikeValidationReport;
}

export type { FeatureCollectionLike };
