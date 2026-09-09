import { activityCompanyId } from "./company.service";
import type { UploadedFile } from "@prisma/client";
import type { HealStatus } from "./analysis-store.service";
import { buildUploadWhere, type FileListFilters } from "./file-list-filters";
import { database } from "./database.service";

export interface CreateUploadRecordInput {
  id: string;
  userId: string;
  name: string;
  originalName: string;
  storedFileName: string;
  storagePath: string;
  mimeType: string;
  sizeInBytes: number;
  identifiedIssues: number;
}

export interface UploadRecordPage {
  records: UploadedFile[];
  total: number;
}

export interface UserUploadSummary {
  fileCount: number;
  identifiedIssues: number;
  healedIssues: number;
}

export const createUploadRecord = (
  input: CreateUploadRecordInput,
): Promise<UploadedFile> =>
  database.$transaction(async (tx) => {
    // Serialize membership changes and upload attribution for this user.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${input.userId}::uuid FOR UPDATE`;
    const companyId = await activityCompanyId(tx, input.userId);
    const record = await tx.uploadedFile.create({ data: input });
    await tx.uploadActivity.create({
      data: {
        id: record.id,
        userId: record.userId,
        companyId,
        sizeInBytes: record.sizeInBytes,
        identifiedIssues: record.identifiedIssues,
        createdAt: record.createdAt,
      },
    });
    return record;
  });

export const deleteUploadRecord = async (id: string): Promise<void> => {
  await database.$transaction([
    database.uploadActivity.deleteMany({ where: { id } }),
    database.uploadedFile.deleteMany({ where: { id } }),
  ]);
};

export const findUploadRecord = (id: string): Promise<UploadedFile | null> =>
  database.uploadedFile.findUnique({ where: { id } });

export const createUploadRecordLister =
  (client = database) =>
  async (
    userId: string,
    skip: number,
    limit: number,
    filters: FileListFilters = {},
  ): Promise<UploadRecordPage> => {
    const where = buildUploadWhere(userId, filters);
    const [records, total] = await client.$transaction([
      client.uploadedFile.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
      client.uploadedFile.count({ where }),
    ]);
    return { records, total };
  };

export const listUserUploadRecords = createUploadRecordLister();

export const findUserUploadRecord = (
  id: string,
  userId: string,
): Promise<UploadedFile | null> =>
  database.uploadedFile.findFirst({ where: { id, userId } });

export const renameUserUploadRecord = async (
  id: string,
  userId: string,
  name: string,
): Promise<UploadedFile | null> => {
  const result = await database.uploadedFile.updateMany({
    where: { id, userId },
    data: { name },
  });
  if (result.count === 0) return null;
  return findUserUploadRecord(id, userId);
};

export const deleteUserUploadRecord = async (
  id: string,
  userId: string,
): Promise<boolean> => {
  return database.$transaction(async (tx) => {
    const result = await tx.uploadedFile.deleteMany({ where: { id, userId } });
    if (result.count)
      await tx.uploadActivity.updateMany({
        where: { id, userId },
        data: { deletedAt: new Date() },
      });
    return result.count > 0;
  });
};

export const updateUploadHealingMetrics = async (
  id: string,
  healStatus: HealStatus,
  healedIssues?: number,
): Promise<void> => {
  const data = {
    healStatus,
    ...(healedIssues === undefined ? {} : { healedIssues }),
  };
  await database.$transaction([
    database.uploadedFile.updateMany({ where: { id }, data }),
    database.uploadActivity.updateMany({ where: { id }, data }),
  ]);
};

export const getUserUploadSummary = async (
  userId: string,
): Promise<UserUploadSummary> => {
  const aggregate = await database.uploadedFile.aggregate({
    where: { userId },
    _count: { _all: true },
    _sum: { identifiedIssues: true, healedIssues: true },
  });
  return {
    fileCount: aggregate._count._all,
    identifiedIssues: aggregate._sum.identifiedIssues ?? 0,
    healedIssues: aggregate._sum.healedIssues ?? 0,
  };
};
