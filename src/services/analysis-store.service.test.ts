import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getAnalysis,
  markAnalysisCompleted,
  markAnalysisFailed,
  markAnalysisProcessing,
  markAnalysisProgress,
  markAnalysisQueued,
  resetAnalysisQueueRequest,
  saveAnalysis,
} from "./analysis-store.service";
import { DryRunReport } from "./dry-run.service";

const emptyReport: DryRunReport = {
  mode: "dry-run",
  valid: true,
  summary: {
    featuresScanned: 0,
    checksRun: 1,
    issuesFound: 0,
    issueGroups: 0,
    affectedFeatures: 0,
    autoRepairableIssues: 0,
    manualReviewIssues: 0,
  },
  issueGroups: [],
  affectedFeatureCollection: {
    type: "FeatureCollection",
    features: [],
  },
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
  checks: {
    geometryTypes: {
      valid: true,
      issues: [],
    },
  },
};

test("persists and marks a dry-run record as queued", async (t) => {
  const storeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "snapgis-analysis-"),
  );
  t.after(() => fs.rm(storeDirectory, { recursive: true, force: true }));
  const jobData = {
    fileName: "stored.geojson",
    originalName: "source.geojson",
    filePath: "/tmp/source.geojson",
    size: 12,
    tolerance: 25,
  };

  const saved = await saveAnalysis(jobData, emptyReport, storeDirectory);
  const loaded = await getAnalysis(saved.id, storeDirectory);

  assert.deepEqual(loaded, saved);
  const queued = await markAnalysisQueued(
    saved,
    saved.id,
    storeDirectory,
  );
  assert.equal(queued.queueJobId, saved.id);
  assert.ok(queued.queuedAt);
  assert.equal(queued.healStatus, "queued");

  await markAnalysisProcessing(saved.id, storeDirectory);
  await markAnalysisProgress(saved.id, 42, storeDirectory);
  const completed = await markAnalysisCompleted(
    saved.id,
    {
      outputFileName: "cleaned-source.geojson",
      outputFilePath: "/tmp/cleaned-source.geojson",
      gapsClosed: 2,
    },
    storeDirectory,
  );
  assert.equal(completed?.healStatus, "completed");
  assert.equal(completed?.healProgress, 100);
  assert.ok(completed?.healStartedAt);
  assert.ok(completed?.healCompletedAt);
  assert.equal(completed?.healResult?.gapsClosed, 2);
  assert.deepEqual(await getAnalysis(saved.id, storeDirectory), completed);
});

test("does not let a late queued write downgrade processing state", async (t) => {
  const storeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "snapgis-analysis-race-"),
  );
  t.after(() => fs.rm(storeDirectory, { recursive: true, force: true }));
  const saved = await saveAnalysis(
    {
      fileName: "stored.geojson",
      originalName: "source.geojson",
      filePath: "/tmp/source.geojson",
      size: 12,
      tolerance: 25,
    },
    emptyReport,
    storeDirectory,
  );

  await Promise.all([
    markAnalysisProcessing(saved.id, storeDirectory),
    markAnalysisQueued(saved, saved.id, storeDirectory),
  ]);
  const stored = await getAnalysis(saved.id, storeDirectory);
  assert.equal(stored?.healStatus, "processing");
  assert.equal(stored?.queueJobId, saved.id);
});

test("resets a terminal failure so healing can be queued again", async (t) => {
  const storeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "snapgis-analysis-retry-"),
  );
  t.after(() => fs.rm(storeDirectory, { recursive: true, force: true }));
  const saved = await saveAnalysis(
    {
      fileName: "stored.geojson",
      originalName: "source.geojson",
      filePath: "/tmp/source.geojson",
      size: 12,
      tolerance: 25,
    },
    emptyReport,
    storeDirectory,
  );
  await markAnalysisQueued(saved, saved.id, storeDirectory);
  await markAnalysisFailed(saved.id, "failed", storeDirectory);

  const reset = await resetAnalysisQueueRequest(saved.id, storeDirectory);
  assert.equal(reset?.healStatus, "dry-run-complete");
  assert.equal(reset?.queueJobId, null);
  assert.equal(reset?.healError, null);
  assert.equal(reset?.healProgress, 0);
});

test("rejects invalid IDs instead of resolving arbitrary paths", async () => {
  await assert.rejects(
    getAnalysis("../../etc/passwd", "/tmp"),
    /Invalid analysis ID/,
  );
});
