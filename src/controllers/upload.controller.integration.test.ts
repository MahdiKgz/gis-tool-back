import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextFunction, Request, Response } from "express";
import { getAnalysis } from "../services/analysis-store.service";
import { CreateUploadRecordInput } from "../services/upload-record.service";
import { createUploadHandler } from "./upload.controller";

test("upload controller performs a dry run and does not enqueue healing", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "snapgis-upload-"),
  );
  const uploadedPath = path.join(temporaryDirectory, "uploaded.geojson");
  await fs.copyFile(
    path.resolve(
      "src/test-data/geojson/geo-001-duplicate-vertices.geojson",
    ),
    uploadedPath,
  );
  t.after(() =>
    fs.rm(temporaryDirectory, { recursive: true, force: true }),
  );

  const request = {
    auth: { userId: "6c2d5ee6-9852-4ddd-86db-f62582ef93de", roles: ["user"] },
    body: { name: "  Parcel boundaries  ", tolerance: "25" },
    file: {
      filename: "uploaded.geojson",
      originalname: "duplicate-vertices.geojson",
      path: uploadedPath,
      size: (await fs.stat(uploadedPath)).size,
      mimetype: "application/geo+json",
    },
  } as Request;
  let statusCode = 0;
  type UploadResponseBody = {
    success: boolean;
    data: {
      jobId: string;
      userId: string;
      name: string;
      status: string;
      report: {
        mode: string;
        summary: { issuesFound: number; issueGroups: number };
        issueGroups: Array<{
          groupId: string;
          issueCount: number;
          affectedFeatureIndexes: number[];
        }>;
        affectedFeatureCollection: {
          type: string;
          features: Array<{
            snapgisFeatureIndex: number;
            geometry?: { coordinates?: unknown };
          }>;
        };
      };
      heal: { method: string; path: string };
    };
  };
  const capture: { body?: UploadResponseBody } = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: UploadResponseBody) {
      capture.body = body;
      return this;
    },
  } as unknown as Response;
  const next = ((error?: unknown) => {
    if (error) throw error;
  }) as NextFunction;
  let createdRecord: CreateUploadRecordInput | undefined;
  const uploadGeoJson = createUploadHandler({
    createRecord: async (input) => {
      createdRecord = input;
    },
    deleteRecord: async () => undefined,
  });

  await uploadGeoJson(request, response, next);

  assert.equal(statusCode, 201);
  assert.ok(capture.body);
  const body = capture.body;
  assert.equal(body.success, true);
  assert.equal(body.data.name, "Parcel boundaries");
  assert.equal(body.data.userId, request.auth?.userId);
  assert.equal(body.data.status, "dry-run-complete");
  assert.equal(body.data.report.mode, "dry-run");
  assert.ok(body.data.report.summary.issuesFound > 0);
  assert.ok(body.data.report.summary.issueGroups > 0);
  assert.ok(
    body.data.report.issueGroups.every(
      (group) =>
        group.groupId.length > 0 &&
        group.issueCount > 0 &&
        group.affectedFeatureIndexes.length > 0,
    ),
  );
  assert.equal(body.data.report.affectedFeatureCollection.type, "FeatureCollection");
  assert.ok(
    body.data.report.affectedFeatureCollection.features.some(
      (feature) =>
        feature.snapgisFeatureIndex === 0 &&
        Array.isArray(feature.geometry?.coordinates),
    ),
  );
  assert.deepEqual(body.data.heal, {
    method: "POST",
    path: `/api/heal/${body.data.jobId}`,
  });

  assert.ok(createdRecord);
  assert.equal(createdRecord.id, body.data.jobId);
  assert.equal(createdRecord.userId, request.auth?.userId);
  assert.equal(createdRecord.name, "Parcel boundaries");
  assert.equal(createdRecord.originalName, "duplicate-vertices.geojson");
  assert.equal(createdRecord.storedFileName, "uploaded.geojson");
  assert.equal(createdRecord.storagePath, path.resolve(uploadedPath));
  assert.equal(createdRecord.mimeType, "application/geo+json");
  assert.equal(createdRecord.sizeInBytes, request.file?.size);
  assert.equal(
    createdRecord.identifiedIssues,
    body.data.report.summary.issuesFound,
  );

  const analysis = await getAnalysis(body.data.jobId);
  assert.ok(analysis);
  assert.equal(analysis.ownerId, request.auth?.userId);
  assert.equal(analysis.queueJobId, null);
  assert.equal(analysis.queuedAt, null);
  t.after(() =>
    fs.rm(
      path.resolve("uploads/gis_analyses", `${analysis.id}.json`),
      { force: true },
    ),
  );
});
