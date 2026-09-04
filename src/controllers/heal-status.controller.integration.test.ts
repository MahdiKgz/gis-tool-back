import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { NextFunction, Request, Response } from "express";
import {
  getAnalysis,
  markAnalysisCompleted,
  saveAnalysis,
  type StoredAnalysis,
} from "../services/analysis-store.service";
import { DryRunReport } from "../services/dry-run.service";
import {
  downloadHealedOutput,
  createHealEventStream,
  getHealStatus,
  previewOriginalInput,
  previewHealedOutput,
  updateManualReview,
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
    minimumGapWidthMeters: 0.025,
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
  await fs.writeFile(analysis.jobData.filePath, JSON.stringify(output), "utf8");
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
    await fs.rm(analysis.jobData.filePath, { force: true });
    await fs.rm(path.resolve("uploads/gis_analyses", `${analysis.id}.json`), {
      force: true,
    });
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

  let originalBody: unknown;
  const originalResponse = {
    type() {
      return this;
    },
    status(code: number) {
      assert.equal(code, 200);
      return this;
    },
    json(body: unknown) {
      originalBody = body;
      return this;
    },
  } as unknown as Response;
  await previewOriginalInput(request, originalResponse, next);
  assert.deepEqual(originalBody, output);

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
    id: "2",
    type: "progress",
    data: {
      value: 60,
      stage: "healing",
      issueCounts: { gap: 1, sliver: 2, kink: 3, spike: 4 },
    },
  });
  listener({
    id: "3",
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

test("replays persisted events after Last-Event-ID without emitting a new snapshot", async () => {
  const analysis = {
    id: "19c53c73-b994-4723-abf1-ab2f87e05679",
    ownerId,
    createdAt: "2026-09-03T10:00:00.000Z",
    queuedAt: "2026-09-03T10:00:01.000Z",
    queueJobId: "19c53c73-b994-4723-abf1-ab2f87e05679",
    healStatus: "processing",
    healProgress: 60,
    healStartedAt: "2026-09-03T10:00:02.000Z",
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
  const chunks: string[] = [];
  const request = Object.assign(new EventEmitter(), {
    params: { jobId: analysis.id },
    auth: { userId: ownerId, roles: ["user"] },
    get: (name: string) => (name === "Last-Event-ID" ? "7" : undefined),
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
      return this;
    },
  } as unknown as Response;
  let requestedLastEventId = "";
  const handler = createHealEventStream({
    getOwnedAnalysis: async () => analysis,
    subscribe: () => () => undefined,
    replay: async (_jobId, lastEventId) => {
      requestedLastEventId = lastEventId;
      return [
        {
          id: "8",
          type: "progress",
          data: {
            value: 75,
            stage: "report-generation",
            issueCounts: { gap: 1, sliver: 0, kink: 0, spike: 0 },
          },
        },
        {
          id: "9",
          type: "completed",
          result: {
            gapsClosed: 1,
            outputFileName: "cleaned-parcels.geojson",
            outputFilePath: "/tmp/cleaned-parcels.geojson",
          },
        },
      ];
    },
    store: async () => {
      throw new Error("replay should not create a snapshot");
    },
    heartbeatMilliseconds: 60_000,
  });

  await handler(request, response, ((error?: unknown) => {
    if (error) throw error;
  }) as NextFunction);

  const stream = chunks.join("");
  assert.equal(requestedLastEventId, "7");
  assert.doesNotMatch(stream, /event: snapshot/);
  assert.match(stream, /id: 8\nevent: progress/);
  assert.match(stream, /id: 9\nevent: completed/);
});

test("persists authenticated manual-review decisions", async (t) => {
  const analysis = await saveAnalysis(
    {
      fileName: "uploaded.geojson",
      originalName: "parcels.geojson",
      filePath: "/tmp/uploaded-review.geojson",
      size: 12,
      tolerance: 25,
    },
    {
      ...emptyReport,
      summary: {
        ...emptyReport.summary,
        issuesFound: 1,
        manualReviewIssues: 1,
      },
      issues: [
        {
          check: "spikes",
          code: "SPIKE",
          featureIndex: 0,
          featureId: "parcel-1",
          relatedFeatureIndex: null,
          relatedFeatureId: null,
          geometryType: "Polygon",
          location: {
            geometryCollectionPath: [],
            relatedGeometryCollectionPath: [],
            coordinatePath: [0, 1],
            relatedCoordinatePath: null,
            polygonPath: [0],
            relatedPolygonPath: null,
          },
          disposition: "ManualReview",
          details: {},
        },
      ],
    },
    undefined,
    ownerId,
  );
  t.after(() =>
    fs.rm(path.resolve("uploads/gis_analyses", `${analysis.id}.json`), {
      force: true,
    }),
  );
  let body: unknown;
  await updateManualReview(
    {
      params: { jobId: analysis.id, issueIndex: "0" },
      body: { action: "approved" },
      auth: { userId: ownerId, roles: ["user"] },
    } as unknown as Request,
    {
      status(code: number) {
        assert.equal(code, 200);
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as unknown as Response,
    ((error?: unknown) => {
      if (error) throw error;
    }) as NextFunction,
  );

  assert.equal(
    (body as { data: { decision: { action: string } } }).data.decision.action,
    "approved",
  );
  assert.equal(
    (await getAnalysis(analysis.id))?.reviewDecisions?.["0"]?.action,
    "approved",
  );
});
