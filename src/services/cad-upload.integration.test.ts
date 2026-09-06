import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Request, Response, NextFunction } from "express";
import { createUploadHandler } from "../controllers/upload.controller";
import { getAnalysis, deleteAnalysis } from "./analysis-store.service";
import { normalizedCadPath, readCadFile, runCadConversion } from "./cad-file.service";
import type { GisJobData } from "../types/gis-job";

const integration = process.env.CAD_INTEGRATION === "1" ? test : test.skip;

type TestJob = { id: string; data: GisJobData; updateProgress: (value: unknown) => Promise<void> };
// Exercise the real worker processor while replacing only queue transport.
// No jobs are submitted to the user's Redis instance by this test.
const loadProcessor = (): ((job: TestJob) => Promise<{ outputFilePath: string }>) => {
  const bullPath = require.resolve("bullmq");
  const queuePath = require.resolve("./queue.service");
  const bull = require("bullmq");
  const previousBull = require.cache[bullPath]!.exports;
  const previousQueue = require.cache[queuePath];
  let processor!: (job: TestJob) => Promise<{ outputFilePath: string }>;
  require.cache[bullPath]!.exports = {
    ...bull,
    Worker: class {
      constructor(_name: string, handler: typeof processor) { processor = handler; }
      on() { return this; }
    },
  };
  require.cache[queuePath] = {
    id: queuePath, filename: queuePath, loaded: true,
    exports: { redisConnection: { exists: async () => 0 }, gisQueue: {} },
  } as NodeModule;
  try { require("../workers/gis.worker"); }
  finally {
    require.cache[bullPath]!.exports = previousBull;
    if (previousQueue) require.cache[queuePath] = previousQueue;
    else delete require.cache[queuePath];
  }
  assert.ok(processor);
  return processor;
};

integration("real DWG and DGN uploads pass dry-run, preview and the complete healing processor", async (t) => {
  const processJob = loadProcessor();
  for (const extension of ["dwg", "dgn"]) {
    await t.test(extension, async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-upload-"));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const name = `projected-parcel.${extension}`;
      const source = path.join(dir, name);
      await fs.copyFile(path.resolve("src/test-data/cad", name), source);
      const request = {
        auth: { userId: "6c2d5ee6-9852-4ddd-86db-f62582ef93de", roles: ["user"] },
        body: { name: "CAD parcel", tolerance: "25", sourceCrs: "EPSG:32639" },
        file: { filename: path.basename(dir) + "." + extension, originalname: name, path: source, size: (await fs.stat(source)).size },
      } as Request;
      let status = 0;
      let body: any;
      const response = {
        status(code: number) { status = code; return this; },
        json(value: unknown) { body = value; return this; },
      } as unknown as Response;
      const handler = createUploadHandler({ createRecord: async () => undefined, deleteRecord: async () => undefined });
      await handler(request, response, ((error: unknown) => { if (error) throw error; }) as NextFunction);
      assert.equal(status, 201);
      const analysis = await getAnalysis(body.data.jobId);
      assert.ok(analysis);
      t.after(() => deleteAnalysis(analysis.id));
      assert.equal(analysis.jobData.sourceCrs, "EPSG:32639");
      assert.equal(analysis.queueJobId, null);
      assert.equal(analysis.report.summary.featuresScanned, 1);
      const before = await fs.readFile(normalizedCadPath(source), "utf8");
      const preview = await readCadFile(source) as any;
      assert.equal(preview.features[0].geometry.type, "Polygon");
      const [lon, lat] = preview.features[0].geometry.coordinates[0][0];
      assert.ok(Math.abs(lon - 51) < 0.001);
      assert.ok(lat > 35 && lat < 36);
      const progress: unknown[] = [];
      const result = await processJob({ id: analysis.id, data: analysis.jobData, updateProgress: async (value) => { progress.push(value); } });
      t.after(() => fs.rm(result.outputFilePath, { force: true }));
      const healed = JSON.parse(await fs.readFile(result.outputFilePath, "utf8"));
      assert.equal(healed.type, "FeatureCollection");
      assert.equal(healed.features.length, 1);
      assert.ok(progress.length > 0);
      assert.equal(await fs.readFile(normalizedCadPath(source), "utf8"), before);
    });
  }
});

integration("invalid CAD, missing runtime and unsupported DGN v8 produce structured failures", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-errors-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "invalid.dwg");
  const output = path.join(dir, "output.geojson");
  await fs.writeFile(source, "invalid drawing");
  await assert.rejects(runCadConversion(source, output, "EPSG:32639"), { code: "INVALID_CAD_FILE" });
  const previousPython = process.env.CAD_PYTHON;
  process.env.CAD_PYTHON = path.join(dir, "missing-python");
  try {
    await assert.rejects(runCadConversion(source, output, "EPSG:32639"), { code: "CAD_RUNTIME_UNAVAILABLE" });
  } finally {
    if (previousPython === undefined) delete process.env.CAD_PYTHON;
    else process.env.CAD_PYTHON = previousPython;
  }
  const v8 = path.join(dir, "v8.dgn");
  await fs.writeFile(v8, Buffer.from("d0cf11e0a1b11ae1", "hex"));
  // This is a runtime capability check, not a valid DGN-v8 sample conversion.
  await assert.rejects(runCadConversion(v8, output, "EPSG:32639"), (error: any) => ["DGN_V8_UNAVAILABLE", "INVALID_CAD_FILE"].includes(error.code));
});

integration("a persistence failure after real CAD conversion removes all upload artifacts", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-persist-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "parcel.dgn");
  await fs.copyFile(path.resolve("src/test-data/cad/projected-parcel.dgn"), source);
  let removedRecord: string | undefined;
  let captured: unknown;
  const failure = new Error("database unavailable");
  const handler = createUploadHandler({
    createRecord: async () => { throw failure; },
    deleteRecord: async (id) => { removedRecord = id; },
  });
  await handler({
    auth: { userId: "6c2d5ee6-9852-4ddd-86db-f62582ef93de" },
    body: { name: "CAD parcel", tolerance: "25", sourceCrs: "EPSG:32639" },
    file: { path: source, originalname: "parcel.dgn", filename: "parcel.dgn", size: (await fs.stat(source)).size },
  } as Request, {} as Response, ((error: unknown) => { captured = error; }) as NextFunction);
  assert.equal(captured, failure);
  assert.ok(removedRecord);
  assert.equal(await getAnalysis(removedRecord), null);
  assert.deepEqual(await fs.readdir(dir), []);
});
