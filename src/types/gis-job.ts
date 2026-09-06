export interface GisJobData {
  fileName: string;
  originalName: string;
  filePath: string;
  size: number;
  tolerance: number;
  sourceCrs?: string;
  overlapThresholdRatio?: number;
  nearDuplicateMaxOffsetMeters?: number;
  nearDuplicateMinIoU?: number;
}
