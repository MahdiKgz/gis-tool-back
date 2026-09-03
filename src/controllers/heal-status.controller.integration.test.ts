import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { NextFunction, Request, Response } from "express";
import {
  markAnalysisCompleted,
  saveAnalysis,
  type StoredAnalysis,
} from "../services/analysis-store.service";
import { DryRunReport } from "../services/dry-run.service";
import {
  downloadHealedOutput,
  createHealEventStream,
  getHealStatus,
  previewHealedOutput,
} from "./heal-status.controller";
import type { HealingQueueEvent } from "../services/heal-event.service";

const emptyReport = {
  mode: "dry-run",
  valid: true,
  summary: {
    featuresScanned: 0,
    checksRun: 0,
    issuesFound: 0,
    issueGroups: 0,
    affectedFeatures: 0,
    autoRepairableIssues: 0,
    manualReviewIssues: 0,
  },
  issueGroups: [],
  affectedFeatureCollection: { type: "FeatureCollection", features: [] },
  appliedOptions: {
    toleranceMillimeters: 25,
    tinyAreaThresholdM2: 0.0625,
    sliverAreaThresholdM2: 0.0625,
    sliverMinCompactness: 0.1,
    gapToleranceMeters: 0.075,
    maxInferredGapWidthMeters: 50,
    lineTopologyToleranceMeters: 0.025,
    maxInferredLineErrorMeters: 100,
    spikeBaseToleranceMeters: 0.025,
    maxCoordinateDecimalPlaces: 9,
  },
  issues: [],
  checks: {},
} as DryRunReport;

const ownerId = "6c2d5ee6-9852-4ddd-86db-f62582ef93de";

test("serves completed status, preview GeoJSON, and attachment download", async (t) => {
  const analysis = await saveAnalysis(
    {
      fileName: "uploaded.geojson",
      originalName: "parcels.geojson",
      filePath: "/tmp/uploaded.geojson",
      size: 12,
      tolerance: 25,
    },
    emptyReport,
    undefined,
    ownerId,
  );
  const outputDirectory = path.resolve("uploads/cleaned_files");
  const outputFileName = `cleaned-${analysis.id}.geojson`;
  const outputFilePath = path.join(outputDirectory, outputFileName);
  const output = { type: "FeatureCollection", features: [] };
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(outputFilePath, JSON.stringify(output), "utf8");
  await markAnalysisCompleted(analysis.id, {
    outputFileName,
    outputFilePath,
    gapsClosed: 1,
    originalSizeInBytes: 12,
    optimizedSizeInBytes: 42,
  });
  t.after(async () => {
    await fs.rm(outputFilePath, { force: true });
    await fs.rm(
      path.resolve("uploads/gis_analyses", `${analysis.id}.json`),
      { force: true },
    );
  });

  const request = {
    params: { jobId: analysis.id },
    auth: { userId: ownerId, roles: ["user"] },
  } as unknown as Request;
  const next = ((error?: unknown) => {
    if (error) throw error;
  }) as NextFunction;
  let statusCode = 0;
  let statusBody: {
    data: {
      status: string;
      progress: number;
      result: { repairsApplied: number; output: { downloadPath: string } };
    };
  } | null = null;
  const statusResponse = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: typeof statusBody) {
      statusBody = body;
      return this;
    },
  } as unknown as Response;
  await getHealStatus(request, statusResponse, next);
  assert.equal(statusCode, 200);
  assert.ok(statusBody);
  const status = statusBody as {
    data: {
      status: string;
      progress: number;
      result: { repairsApplied: number; output: { downloadPath: string } };
    };
  };
  assert.equal(status.data.status, "completed");
  assert.equal(status.data.progress, 100);
  assert.equal(status.data.result.repairsApplied, 1);
  assert.equal(
    status.data.result.output.downloadPath,
    `/api/heal/${analysis.id}/download`,
  );

  let previewType = "";
  let previewPath = "";
  const previewResponse = {
    type(value: string) {
      previewType = value;
      return this;
    },
    sendFile(filePath: string) {
      previewPath = filePath;
      return this;
    },
  } as unknown as Response;
  await previewHealedOutput(request, previewResponse, next);
  assert.equal(previewType, "application/geo+json");
  assert.equal(previewPath, outputFilePath);
  assert.deepEqual(JSON.parse(await fs.readFile(previewPath, "utf8")), output);

  let downloadedPath = "";
  let downloadedName = "";
  const downloadResponse = {
    headersSent: false,
    download(
      filePath: string,
      fileName: string,
      callback: (error?: Error) => void,
    ) {
      downloadedPath = filePath;
      downloadedName = fileName;
      callback();
      return this;
    },
  } as unknown as Response;
  await downloadHealedOutput(request, downloadResponse, next);
  assert.equal(downloadedPath, outputFilePath);
  assert.equal(downloadedName, outputFileName);
});

test("streams heartbeat, staged progress, and the completed healing result", async () => {
  const analysis = {
    id: "19c53c73-b994-4723-abf1-ab2f87e05679",
    ownerId,
    createdAt: "2026-09-03T10:00:00.000Z",
    queuedAt: "2026-09-03T10:00:01.000Z",
    queueJobId: "19c53c73-b994-4723-abf1-ab2f87e05679",
    healStatus: "queued",
    healProgress: 0,
    healStartedAt: null,
    healCompletedAt: null,
    healFailedAt: null,
    healResult: null,
    healError: null,
    jobData: {
      fileName: "uploaded.geojson",
      originalName: "parcels.geojson",
      filePath: "/tmp/uploaded.geojson",
      size: 12,
      tolerance: 25,
    },
    report: emptyReport,
  } satisfies StoredAnalysis;
  let listener: ((event: HealingQueueEvent) => void) | undefined;
  let ended = false;
  const chunks: string[] = [];
  const request = Object.assign(new EventEmitter(), {
    params: { jobId: analysis.id },
    auth: { userId: ownerId, roles: ["user"] },
  }) as unknown as Request;
  const response = {
    status() {
      return this;
    },
    setHeader() {
      return this;
    },
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
      return this;
    },
  } as unknown as Response;
  const handler = createHealEventStream({
    getOwnedAnalysis: async (_jobId, requestedOwnerId) => {
      assert.equal(requestedOwnerId, ownerId);
      return analysis;
    },
    subscribe: (_jobId, nextListener) => {
      listener = nextListener;
      return () => undefined;
    },
    heartbeatMilliseconds: 5,
  });
  const next = ((error?: unknown) => {
    if (error) throw error;
  }) as NextFunction;

  await handler(request, response, next);
  assert.ok(listener);
  await new Promise((resolve) => setTimeout(resolve, 12));
  listener({
    type: "progress",
    data: {
      value: 60,
      stage: "healing",
      issueCounts: { gap: 1, sliver: 2, kink: 3, spike: 4 },
    },
  });
  listener({
    type: "completed",
    result: {
      gapsClosed: 1,
      outputFileName: "cleaned-parcels.geojson",
      outputFilePath: "/tmp/cleaned-parcels.geojson",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const stream = chunks.join("");
  assert.match(stream, /: heartbeat\n\n/);
  assert.match(stream, /event: snapshot/);
  assert.match(stream, /event: progress/);
  assert.match(stream, /"stage":"healing"/);
  assert.match(stream, /"gap":1/);
  assert.match(stream, /event: completed/);
  assert.match(stream, /"status":"completed"/);
  assert.equal(ended, true);
});
