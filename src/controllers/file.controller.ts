import fs from "node:fs/promises";
import path from "node:path";
import type { UploadedFile } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import { AppError } from "../middlewares/errorHandler";
import {
  deleteAnalysis,
  getAnalysis,
  type HealStatus,
  type StoredAnalysis,
} from "../services/analysis-store.service";
import {
  buildPublicHealResult,
  resolveHealedOutput,
} from "../services/heal-result.service";
import { parseUploadName } from "../services/upload-name.service";
import {
  deleteUserUploadRecord,
  findUserUploadRecord,
  getUserUploadSummary,
  listUserUploadRecords,
  renameUserUploadRecord,
  type UploadRecordPage,
  type UserUploadSummary,
} from "../services/upload-record.service";

const DEFAULT_FILE_LIMIT = 10;
const MAX_FILE_LIMIT = 50;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPLOAD_DIRECTORY = path.resolve("uploads/gis_files");

type PublicFileStatus = HealStatus | "unavailable";

interface FileControllerDependencies {
  getSummary: (userId: string) => Promise<UserUploadSummary>;
  listRecords: (
    userId: string,
    skip: number,
    limit: number,
  ) => Promise<UploadRecordPage>;
  findRecord: (id: string, userId: string) => Promise<UploadedFile | null>;
  renameRecord: (
    id: string,
    userId: string,
    name: string,
  ) => Promise<UploadedFile | null>;
  deleteRecord: (id: string, userId: string) => Promise<boolean>;
  loadAnalysis: (id: string) => Promise<StoredAnalysis | null>;
  removeAnalysis: (id: string) => Promise<void>;
  removeFile: (filePath: string) => Promise<void>;
}

const defaultDependencies: FileControllerDependencies = {
  getSummary: getUserUploadSummary,
  listRecords: listUserUploadRecords,
  findRecord: findUserUploadRecord,
  renameRecord: renameUserUploadRecord,
  deleteRecord: deleteUserUploadRecord,
  loadAnalysis: getAnalysis,
  removeAnalysis: deleteAnalysis,
  removeFile: async (filePath) => fs.rm(filePath, { force: true }),
};

const parsePaginationInteger = (
  value: unknown,
  fallback: number,
  field: "skip" | "limit",
): number => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AppError(
      400,
      `${field} must be a non-negative integer`,
      "INVALID_PAGINATION",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (field === "limit" && parsed === 0)) {
    throw new AppError(
      400,
      field === "limit"
        ? "limit must be a positive integer"
        : "skip must be a non-negative integer",
      "INVALID_PAGINATION",
    );
  }
  if (field === "limit" && parsed > MAX_FILE_LIMIT) {
    throw new AppError(
      400,
      `limit must not exceed ${MAX_FILE_LIMIT}`,
      "INVALID_PAGINATION",
    );
  }
  return parsed;
};

export const parseFilePagination = (query: Request["query"]) => ({
  skip: parsePaginationInteger(query.skip, 0, "skip"),
  limit: parsePaginationInteger(query.limit, DEFAULT_FILE_LIMIT, "limit"),
});

const parseFileId = (value: unknown): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, "A valid file ID is required", "INVALID_FILE_ID");
  }
  return value;
};

const ownedAnalysis = (
  analysis: StoredAnalysis | null,
  userId: string,
): StoredAnalysis | null => (analysis?.ownerId === userId ? analysis : null);

const buildFileSummary = (
  record: UploadedFile,
  analysis: StoredAnalysis | null,
) => {
  const status: PublicFileStatus = analysis?.healStatus ?? "unavailable";
  return {
    id: record.id,
    name: record.name,
    originalName: record.originalName,
    sizeInBytes: record.sizeInBytes,
    uploadedAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    status,
    isHealed: status === "completed",
    issuesFound: analysis?.report.summary.issuesFound ?? null,
  };
};

const buildFileDetail = (
  record: UploadedFile,
  analysis: StoredAnalysis | null,
) => {
  const summary = buildFileSummary(record, analysis);
  return {
    ...summary,
    mimeType: record.mimeType,
    report: analysis?.report ?? null,
    healing: {
      progress: analysis?.healProgress ?? 0,
      queuedAt: analysis?.queuedAt ?? null,
      startedAt: analysis?.healStartedAt ?? null,
      completedAt: analysis?.healCompletedAt ?? null,
      failedAt: analysis?.healFailedAt ?? null,
      error: analysis?.healError ?? null,
      result:
        analysis?.healStatus === "completed"
          ? buildPublicHealResult(analysis)
          : null,
    },
    reviewDecisions: analysis?.reviewDecisions ?? {},
  };
};

const resolveOwnedAnalysis = async (
  id: string,
  userId: string,
  loadAnalysis: FileControllerDependencies["loadAnalysis"],
): Promise<StoredAnalysis | null> => {
  try {
    return ownedAnalysis(await loadAnalysis(id), userId);
  } catch (error) {
    console.error(`Could not load analysis ${id}:`, error);
    return null;
  }
};

const resolveUploadPath = (filePath: string): string | null => {
  const resolved = path.resolve(filePath);
  const relative = path.relative(UPLOAD_DIRECTORY, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  return resolved;
};

export const createFileController = (
  dependencies: FileControllerDependencies = defaultDependencies,
) => ({
  getDashboardSummary: async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const usage = await dependencies.getSummary(userId);
      res.status(200).json({
        success: true,
        data: {
          plan: {
            code: "free",
            name: "رایگان",
            expiresAt: null,
            remainingDays: null,
          },
          usage: {
            files: usage.fileCount,
            identifiedIssues: usage.identifiedIssues,
            healedIssues: usage.healedIssues,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },

  listFiles: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { skip, limit } = parseFilePagination(req.query);
      const { records, total } = await dependencies.listRecords(
        userId,
        skip,
        limit,
      );
      const items = await Promise.all(
        records.map(async (record) =>
          buildFileSummary(
            record,
            await resolveOwnedAnalysis(
              record.id,
              userId,
              dependencies.loadAnalysis,
            ),
          ),
        ),
      );
      res.status(200).json({
        success: true,
        data: {
          items,
          pagination: {
            skip,
            limit,
            total,
            hasMore: skip + items.length < total,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },

  getFile: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const id = parseFileId(req.params.fileId);
      const record = await dependencies.findRecord(id, userId);
      if (!record) throw new AppError(404, "File not found", "FILE_NOT_FOUND");
      const analysis = await resolveOwnedAnalysis(
        id,
        userId,
        dependencies.loadAnalysis,
      );
      res
        .status(200)
        .json({ success: true, data: buildFileDetail(record, analysis) });
    } catch (error) {
      next(error);
    }
  },

  renameFile: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const id = parseFileId(req.params.fileId);
      const name = parseUploadName(req.body?.name);
      const record = await dependencies.renameRecord(id, userId, name);
      if (!record) throw new AppError(404, "File not found", "FILE_NOT_FOUND");
      const analysis = await resolveOwnedAnalysis(
        id,
        userId,
        dependencies.loadAnalysis,
      );
      res
        .status(200)
        .json({ success: true, data: buildFileSummary(record, analysis) });
    } catch (error) {
      next(error);
    }
  },

  deleteFile: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const id = parseFileId(req.params.fileId);
      const record = await dependencies.findRecord(id, userId);
      if (!record) throw new AppError(404, "File not found", "FILE_NOT_FOUND");
      const analysis = await resolveOwnedAnalysis(
        id,
        userId,
        dependencies.loadAnalysis,
      );
      if (
        analysis?.healStatus === "queued" ||
        analysis?.healStatus === "processing"
      ) {
        throw new AppError(
          409,
          "A file cannot be deleted while healing is in progress",
          "FILE_BUSY",
        );
      }

      if (!(await dependencies.deleteRecord(id, userId))) {
        throw new AppError(404, "File not found", "FILE_NOT_FOUND");
      }

      const cleanupTasks: Promise<void>[] = [dependencies.removeAnalysis(id)];
      const uploadPath = resolveUploadPath(record.storagePath);
      if (uploadPath) cleanupTasks.push(dependencies.removeFile(uploadPath));
      const healedOutput = analysis ? resolveHealedOutput(analysis) : null;
      if (healedOutput)
        cleanupTasks.push(dependencies.removeFile(healedOutput.filePath));
      const cleanupResults = await Promise.allSettled(cleanupTasks);
      if (cleanupResults.some((result) => result.status === "rejected")) {
        console.warn(
          `File record ${id} was deleted but one or more stored files remain`,
        );
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

const fileController = createFileController();
export const {
  deleteFile,
  getDashboardSummary,
  getFile,
  listFiles,
  renameFile,
} = fileController;
