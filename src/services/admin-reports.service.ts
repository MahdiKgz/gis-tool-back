import { database } from "./database.service";
import { requireAdmin, adminFileMetadata } from "./company.service";
import { PLANS } from "./business-plan.service";
import { parseReportRange } from "./admin-inputs";

interface DailyRow {
  date: string;
  uploads: bigint;
  completed: bigint;
  failed: bigint;
  bytes: bigint;
  identifiedIssues: bigint;
  healedIssues: bigint;
}

export const getAdminReports = async (
  actorId: string,
  query: { from?: unknown; to?: unknown },
) => {
  const range = parseReportRange(query);
  const createdAt = { gte: range.start, lt: range.endExclusive };
  return database.$transaction(
    async (tx) => {
      await requireAdmin(tx, actorId);
      const [
        users,
        newUsers,
        companies,
        activeCompanies,
        planGroups,
        usage,
        storedFiles,
        deletedFiles,
        statuses,
        rows,
        recentFailures,
      ] = await Promise.all([
        tx.user.count(),
        tx.user.count({ where: { createdAt } }),
        tx.company.count(),
        tx.company.count({ where: { owner: { planCode: "advanced" } } }),
        tx.user.groupBy({ by: ["planCode"], _count: { _all: true } }),
        tx.uploadActivity.aggregate({
          where: { createdAt },
          _count: { _all: true },
          _sum: {
            sizeInBytes: true,
            identifiedIssues: true,
            healedIssues: true,
          },
        }),
        tx.uploadedFile.count({ where: { createdAt } }),
        tx.uploadActivity.count({
          where: { createdAt, deletedAt: { not: null } },
        }),
        tx.uploadActivity.groupBy({
          by: ["healStatus"],
          where: { createdAt },
          _count: { _all: true },
          orderBy: { healStatus: "asc" },
        }),
        tx.$queryRaw<DailyRow[]>`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          COUNT(*) AS uploads,
          COUNT(*) FILTER (WHERE heal_status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE heal_status = 'failed') AS failed,
          COALESCE(SUM(size_in_bytes), 0)::bigint AS bytes,
          COALESCE(SUM(identified_issues), 0)::bigint AS "identifiedIssues",
          COALESCE(SUM(healed_issues), 0)::bigint AS "healedIssues"
        FROM upload_activity
        WHERE created_at >= ${range.start} AND created_at < ${range.endExclusive}
        GROUP BY date ORDER BY date`,
        tx.uploadedFile.findMany({
          where: { createdAt, healStatus: "failed" },
          select: {
            ...adminFileMetadata,
            user: { select: { id: true, name: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: 10,
        }),
      ]);
      const counts = new Map(
        statuses.map((row) => [row.healStatus, row._count._all]),
      );
      const byDay = new Map(rows.map((row) => [row.date, row]));
      return {
        range: { from: range.from, to: range.to, timeZone: "UTC" },
        summary: {
          users,
          newUsers,
          companies,
          activeCompanies,
          uploads: usage._count._all,
          bytes: usage._sum.sizeInBytes ?? 0,
          identifiedIssues: usage._sum.identifiedIssues ?? 0,
          healedIssues: usage._sum.healedIssues ?? 0,
          storedFiles,
          deletedFiles,
          completed: counts.get("completed") ?? 0,
          failed: counts.get("failed") ?? 0,
          processing:
            (counts.get("processing") ?? 0) + (counts.get("queued") ?? 0),
        },
        plans: PLANS.map((plan) => ({
          code: plan.code,
          name: plan.name,
          count:
            planGroups.find((row) => row.planCode === plan.code)?._count._all ??
            0,
        })),
        statuses: statuses.map((row) => ({
          status: row.healStatus,
          count: row._count._all,
        })),
        daily: Array.from({ length: range.days }, (_, index) => {
          const date = new Date(range.start.getTime() + index * 86400000)
            .toISOString()
            .slice(0, 10);
          const row = byDay.get(date);
          return {
            date,
            uploads: Number(row?.uploads ?? 0),
            completed: Number(row?.completed ?? 0),
            failed: Number(row?.failed ?? 0),
            bytes: Number(row?.bytes ?? 0),
            identifiedIssues: Number(row?.identifiedIssues ?? 0),
            healedIssues: Number(row?.healedIssues ?? 0),
          };
        }),
        recentFailures,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
};
