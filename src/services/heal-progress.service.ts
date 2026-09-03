export type HealingStage =
  | "parsing"
  | "error-detection"
  | "healing"
  | "report-generation";

export interface HealingIssueCounts {
  gap: number;
  sliver: number;
  kink: number;
  spike: number;
}

export interface HealingProgress {
  value: number;
  stage: HealingStage;
  issueCounts: HealingIssueCounts;
}

const STAGES = new Set<HealingStage>([
  "parsing",
  "error-detection",
  "healing",
  "report-generation",
]);

const normalizeCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;

export const createHealingProgress = (
  value: number,
  stage: HealingStage,
  issueCounts: Partial<HealingIssueCounts> = {},
): HealingProgress => ({
  value: Math.max(0, Math.min(100, value)),
  stage,
  issueCounts: {
    gap: normalizeCount(issueCounts.gap),
    sliver: normalizeCount(issueCounts.sliver),
    kink: normalizeCount(issueCounts.kink),
    spike: normalizeCount(issueCounts.spike),
  },
});

export const parseHealingProgress = (
  value: unknown,
): HealingProgress | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HealingProgress>;
  if (
    typeof candidate.value !== "number" ||
    !Number.isFinite(candidate.value) ||
    typeof candidate.stage !== "string" ||
    !STAGES.has(candidate.stage as HealingStage)
  ) {
    return null;
  }
  return createHealingProgress(
    candidate.value,
    candidate.stage as HealingStage,
    candidate.issueCounts,
  );
};
