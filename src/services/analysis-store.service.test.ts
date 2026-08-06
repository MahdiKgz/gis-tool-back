import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getAnalysis,
  markAnalysisQueued,
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
  assert.deepEqual(await getAnalysis(saved.id, storeDirectory), queued);
});

test("rejects invalid IDs instead of resolving arbitrary paths", async () => {
  await assert.rejects(
    getAnalysis("../../etc/passwd", "/tmp"),
    /Invalid analysis ID/,
  );
});
