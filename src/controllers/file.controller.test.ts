import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { UploadedFile } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../middlewares/errorHandler";
import type { StoredAnalysis } from "../services/analysis-store.service";
import { createFileController, parseFilePagination } from "./file.controller";

const userId = "6c2d5ee6-9852-4ddd-86db-f62582ef93de";
const fileId = "19c53c73-b994-4723-abf1-ab2f87e05679";

const record = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
  id: fileId,
  userId,
  name: "Parcel boundaries",
  originalName: "parcels.geojson",
  storedFileName: "stored-parcels.geojson",
  storagePath: path.resolve("uploads/gis_files/stored-parcels.geojson"),
  mimeType: "application/geo+json",
  sizeInBytes: 1024,
  createdAt: new Date("2026-09-03T06:30:00.000Z"),
  updatedAt: new Date("2026-09-03T06:30:00.000Z"),
  ...overrides,
});

const analysis = (overrides: Partial<StoredAnalysis> = {}): StoredAnalysis =>
  ({
    id: fileId,
    ownerId: userId,
    createdAt: "2026-09-03T06:30:00.000Z",
    queuedAt: null,
    queueJobId: null,
    healStatus: "dry-run-complete",
    healProgress: 0,
    healStartedAt: null,
    healCompletedAt: null,
    healFailedAt: null,
    healResult: null,
    healError: null,
    jobData: {},
    report: { summary: { issuesFound: 4 } },
    ...overrides,
  }) as StoredAnalysis;

const responseCapture = () => {
  const capture: { status?: number; body?: unknown } = {};
  const response = {
    status(status: number) {
      capture.status = status;
      return this;
    },
    json(body: unknown) {
      capture.body = body;
      return this;
    },
    send() {
      return this;
    },
  } as unknown as Response;
  return { capture, response };
};

const nextCapture = () => {
  const capture: { error?: unknown } = {};
  const next = ((error?: unknown) => {
    capture.error = error;
  }) as NextFunction;
  return { capture, next };
};

const dependencies = (
  overrides: Partial<Parameters<typeof createFileController>[0]> = {},
): Parameters<typeof createFileController>[0] => ({
  listRecords: async () => ({ records: [], total: 0 }),
  findRecord: async () => null,
  renameRecord: async () => null,
  deleteRecord: async () => false,
  loadAnalysis: async () => null,
  removeAnalysis: async () => undefined,
  removeFile: async () => undefined,
  ...overrides,
});

test("file pagination uses safe defaults and validates explicit values", () => {
  assert.deepEqual(parseFilePagination({}), { skip: 0, limit: 10 });
  assert.deepEqual(parseFilePagination({ skip: "20", limit: "5" }), {
    skip: 20,
    limit: 5,
  });
  for (const query of [
    { skip: "-1" },
    { skip: "1.5" },
    { limit: "0" },
    { limit: "51" },
  ]) {
    assert.throws(
      () => parseFilePagination(query),
      (error) =>
        error instanceof AppError && error.code === "INVALID_PAGINATION",
    );
  }
});

test("lists only the authenticated user's page with healing summaries", async () => {
  let requested: { userId: string; skip: number; limit: number } | undefined;
  const controller = createFileController(
    dependencies({
      listRecords: async (requestedUserId, skip, limit) => {
        requested = { userId: requestedUserId, skip, limit };
        return { records: [record()], total: 11 };
      },
      loadAnalysis: async () => analysis(),
    }),
  );
  const { capture, response } = responseCapture();
  const { capture: nextResult, next } = nextCapture();
  await controller.listFiles(
    { auth: { userId, roles: ["user"] }, query: {} } as Request,
    response,
    next,
  );

  assert.equal(nextResult.error, undefined);
  assert.deepEqual(requested, { userId, skip: 0, limit: 10 });
  assert.equal(capture.status, 200);
  const body = capture.body as {
    data: {
      items: Array<{
        name: string;
        status: string;
        isHealed: boolean;
        issuesFound: number;
      }>;
      pagination: { hasMore: boolean; total: number };
    };
  };
  assert.equal(body.data.items[0]?.name, "Parcel boundaries");
  assert.equal(body.data.items[0]?.status, "dry-run-complete");
  assert.equal(body.data.items[0]?.isHealed, false);
  assert.equal(body.data.items[0]?.issuesFound, 4);
  assert.deepEqual(body.data.pagination, {
    skip: 0,
    limit: 10,
    total: 11,
    hasMore: true,
  });
});

test("renames only an owned file and trims the requested name", async () => {
  let renamed: { id: string; userId: string; name: string } | undefined;
  const controller = createFileController(
    dependencies({
      renameRecord: async (id, requestedUserId, name) => {
        renamed = { id, userId: requestedUserId, name };
        return record({ name });
      },
      loadAnalysis: async () => analysis(),
    }),
  );
  const { capture, response } = responseCapture();
  const { capture: nextResult, next } = nextCapture();
  await controller.renameFile(
    {
      auth: { userId, roles: ["user"] },
      params: { fileId },
      body: { name: "  Updated parcels  " },
    } as unknown as Request,
    response,
    next,
  );

  assert.equal(nextResult.error, undefined);
  assert.deepEqual(renamed, { id: fileId, userId, name: "Updated parcels" });
  assert.equal(capture.status, 200);
});

test("does not expose another user's file", async () => {
  const controller = createFileController(dependencies());
  const { response } = responseCapture();
  const { capture, next } = nextCapture();
  await controller.getFile(
    {
      auth: { userId, roles: ["user"] },
      params: { fileId },
    } as unknown as Request,
    response,
    next,
  );
  assert.ok(capture.error instanceof AppError);
  assert.equal(capture.error.statusCode, 404);
});

test("rejects deletion while healing is active", async () => {
  let deleted = false;
  const controller = createFileController(
    dependencies({
      findRecord: async () => record(),
      loadAnalysis: async () => analysis({ healStatus: "processing" }),
      deleteRecord: async () => {
        deleted = true;
        return true;
      },
    }),
  );
  const { response } = responseCapture();
  const { capture, next } = nextCapture();
  await controller.deleteFile(
    {
      auth: { userId, roles: ["user"] },
      params: { fileId },
    } as unknown as Request,
    response,
    next,
  );
  assert.equal(deleted, false);
  assert.ok(capture.error instanceof AppError);
  assert.equal(capture.error.code, "FILE_BUSY");
});

test("deletes an owned completed record and all managed artifacts", async () => {
  const removedFiles: string[] = [];
  let removedAnalysis: string | undefined;
  const outputPath = path.resolve(
    "uploads/cleaned_files/cleaned-parcels.geojson",
  );
  const controller = createFileController(
    dependencies({
      findRecord: async () => record(),
      loadAnalysis: async () =>
        analysis({
          healStatus: "completed",
          healProgress: 100,
          healResult: {
            outputFileName: "cleaned-parcels.geojson",
            outputFilePath: outputPath,
          },
        }),
      deleteRecord: async (id, requestedUserId) =>
        id === fileId && requestedUserId === userId,
      removeAnalysis: async (id) => {
        removedAnalysis = id;
      },
      removeFile: async (filePath) => {
        removedFiles.push(filePath);
      },
    }),
  );
  const { capture, response } = responseCapture();
  const { capture: nextResult, next } = nextCapture();
  await controller.deleteFile(
    {
      auth: { userId, roles: ["user"] },
      params: { fileId },
    } as unknown as Request,
    response,
    next,
  );

  assert.equal(nextResult.error, undefined);
  assert.equal(capture.status, 204);
  assert.equal(removedAnalysis, fileId);
  assert.deepEqual(
    removedFiles.sort(),
    [record().storagePath, outputPath].sort(),
  );
});
