import type { DryRunReport } from "./dry-run.service";
import { AppError } from "../middlewares/errorHandler";

/** Keep analytical data intact; only change the representation sent to map clients. */
export function compactReport(report: DryRunReport) {
  return {
    ...report,
    checks: {},
    issues: report.issues.flatMap((issue, issueIndex) =>
      issue.disposition === "ManualReview" ? [{ ...issue, issueIndex, details: {} }] : [],
    ),
    issueDetails: { paginated: true, total: report.issues.length },
  };
}

export function issuePage(report: DryRunReport, query: Record<string, unknown>) {
  const integer = (key: string, fallback: number, max: number) => {
    const value = query[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max)
      throw new AppError(400, `Invalid ${key}`, "INVALID_PAGINATION");
    return Number(value);
  };
  const page = integer("page", 1, Number.MAX_SAFE_INTEGER);
  const limit = integer("limit", 25, 100);
  if (query.code !== undefined && (typeof query.code !== "string" || query.code.length > 128))
    throw new AppError(400, "Invalid issue code", "INVALID_ISSUE_CODE");
  const items: Array<DryRunReport["issues"][number] & { issueIndex: number }> = [];
  const start = (page - 1) * limit;
  if (!Number.isSafeInteger(start)) throw new AppError(400, "Invalid page", "INVALID_PAGINATION");
  let total = 0;
  report.issues.forEach((issue, issueIndex) => {
    if (query.code !== undefined && issue.code !== query.code) return;
    if (total >= start && items.length < limit) items.push({ ...issue, issueIndex });
    total++;
  });
  return { items, page, limit, total };
}
