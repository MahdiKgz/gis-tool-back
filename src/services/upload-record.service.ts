import { UploadedFile } from "@prisma/client";
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

export const createUploadRecord = (
  input: CreateUploadRecordInput,
): Promise<UploadedFile> => database.uploadedFile.create({ data: input });

export const deleteUploadRecord = async (id: string): Promise<void> => {
  await database.uploadedFile.deleteMany({ where: { id } });
};

export const findUploadRecord = (id: string): Promise<UploadedFile | null> =>
  database.uploadedFile.findUnique({ where: { id } });
