import type { UploadedFile } from "@prisma/client";
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
}

export interface UploadRecordPage {
  records: UploadedFile[];
  total: number;
}

export const createUploadRecord = (
  input: CreateUploadRecordInput,
): Promise<UploadedFile> => database.uploadedFile.create({ data: input });

export const deleteUploadRecord = async (id: string): Promise<void> => {
  await database.uploadedFile.deleteMany({ where: { id } });
};

export const findUploadRecord = (id: string): Promise<UploadedFile | null> =>
  database.uploadedFile.findUnique({ where: { id } });

export const listUserUploadRecords = async (
  userId: string,
  skip: number,
  limit: number,
): Promise<UploadRecordPage> => {
  const [records, total] = await database.$transaction([
    database.uploadedFile.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
    database.uploadedFile.count({ where: { userId } }),
  ]);
  return { records, total };
};

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
  const result = await database.uploadedFile.deleteMany({
    where: { id, userId },
  });
  return result.count > 0;
};
