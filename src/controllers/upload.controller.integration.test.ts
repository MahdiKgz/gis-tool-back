import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextFunction, Request, Response } from "express";
import { getAnalysis } from "../services/analysis-store.service";
import { uploadGeoJson } from "./upload.controller";

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
    body: { tolerance: "25" },
    file: {
      filename: "uploaded.geojson",
      originalname: "duplicate-vertices.geojson",
      path: uploadedPath,
      size: (await fs.stat(uploadedPath)).size,
    },
  } as Request;
  let statusCode = 0;
  type UploadResponseBody = {
    success: boolean;
    data: {
      jobId: string;
      status: string;
      report: {
        mode: string;
        summary: { issuesFound: number };
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

  await uploadGeoJson(request, response, next);

  assert.equal(statusCode, 201);
  assert.ok(capture.body);
  const body = capture.body;
  assert.equal(body.success, true);
  assert.equal(body.data.status, "dry-run-complete");
  assert.equal(body.data.report.mode, "dry-run");
  assert.ok(body.data.report.summary.issuesFound > 0);
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
    path: `/heal/${body.data.jobId}`,
  });

  const analysis = await getAnalysis(body.data.jobId);
  assert.ok(analysis);
  assert.equal(analysis.queueJobId, null);
  assert.equal(analysis.queuedAt, null);
  t.after(() =>
    fs.rm(
      path.resolve("uploads/gis_analyses", `${analysis.id}.json`),
      { force: true },
    ),
  );
});
