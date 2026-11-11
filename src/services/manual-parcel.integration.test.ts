import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { globalErrorHandler } from "../middlewares/errorHandler";
import { deleteAnalysis, markAnalysisCompleted, saveAnalysis } from "./analysis-store.service";
import { conversionOutput } from "./conversion.service";
import { analyzeGeoJson } from "./dry-run.service";
import { createConversionHandlers } from "../controllers/conversion.controller";
import {
  downloadHealedOutput,
  getManualReviewParcel,
  previewHealedOutput,
  updateManualReview,
} from "../controllers/heal-status.controller";

test("a confirmed parcel edit survives reordered healing output and is used for preview, download and export", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "snapgis-parcel-test-"));
  const cleaned = path.resolve("uploads/cleaned_files", `${randomUUID()}.geojson`);
  t.after(() =>
    Promise.all([fs.rm(folder, { recursive: true, force: true }), fs.rm(cleaned, { force: true })]),
  );
  const source = path.join(folder, "parcel.geojson");
  const polygon = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ],
    ],
  };
  const parcel = { type: "Feature", id: "parcel-a", properties: { owner: "kept" }, geometry: polygon };
  const other = {
    type: "Feature",
    properties: { marker: true },
    geometry: { type: "Point", coordinates: [9, 9] },
  };
  const collection = { type: "FeatureCollection", features: [parcel, other] };
  await fs.writeFile(source, JSON.stringify(collection));
  const report = analyzeGeoJson(collection, { toleranceMillimeters: 25 });
  const issueIndex = report.issues.findIndex(
    (issue) => issue.featureIndex === 0 && issue.disposition === "ManualReview",
  );
  assert.ok(issueIndex >= 0);
  const owner = randomUUID();
  const analysis = await saveAnalysis(
    {
      fileName: "parcel.geojson",
      originalName: "parcel.geojson",
      filePath: source,
      size: 200,
      tolerance: 25,
    },
    report,
    undefined,
    owner,
  );
  t.after(() => deleteAnalysis(analysis.id));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { userId: req.get("X-Test-Owner") ?? owner, roles: ["user"] };
    next();
  });
  app.get("/:jobId/reviews/:issueIndex", getManualReviewParcel);
  app.patch("/:jobId/reviews/:issueIndex", updateManualReview);
  app.get("/:jobId/output", previewHealedOutput);
  app.get("/:jobId/download", downloadHealedOutput);
  app.post(
    "/:jobId/export",
    createConversionHandlers({
      getJob: async () => null,
      enqueue: async () => assert.fail("Small output must export synchronously"),
      convert: async (task) => {
        assert.equal(task.sourceCRS, "EPSG:4326");
        assert.deepEqual(JSON.parse(await fs.readFile(task.source, "utf8")).features, [
          other,
          { ...parcel, geometry: repaired },
        ]);
        await fs.copyFile(task.source, conversionOutput(task));
        return { features: 2, sourceCRS: "EPSG:4326", targetCRS: "EPSG:4326", warnings: [] };
      },
    }).exportHealed,
  );
  app.use(globalErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/${analysis.id}`;
  const reviewUrl = `${url}/reviews/${issueIndex}`;
  const load = (target: string) => fetch(`${url}/${target}`);
  const save = (revision: string, geometry: typeof polygon) =>
    fetch(reviewUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-edit", geometry, revision }),
    });

  assert.equal((await fetch(reviewUrl, { headers: { "X-Test-Owner": "other-user" } })).status, 404);
  const before = await fetch(reviewUrl);
  assert.equal(before.status, 200);
  const { data: draft } = await before.json();
  assert.deepEqual(draft.geometry, polygon);
  assert.equal(draft.confirmed, false);
  assert.equal((await load("output")).status, 409);
  assert.equal((await save(draft.revision, polygon)).status, 400);

  const repaired = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [2, 1],
        [0, 0],
      ],
    ],
  };
  const attempts = await Promise.all([save(draft.revision, repaired), save(draft.revision, repaired)]);
  assert.deepEqual(attempts.map((res) => res.status).sort(), [200, 409]);
  const reviewed = await load("output");
  assert.equal(reviewed.status, 200);
  assert.deepEqual((await reviewed.json()).features, [{ ...parcel, geometry: repaired }, other]);
  assert.deepEqual(JSON.parse(await fs.readFile(source, "utf8")), collection);

  await fs.mkdir(path.dirname(cleaned), { recursive: true });
  await fs.writeFile(cleaned, JSON.stringify({ ...collection, features: [other, parcel] }));
  const result = { outputFileName: "cleaned-parcels.geojson", outputFilePath: cleaned };
  await markAnalysisCompleted(analysis.id, result);
  assert.deepEqual((await (await load("output")).json()).features, [
    other,
    { ...parcel, geometry: repaired },
  ]);

  await markAnalysisCompleted(analysis.id, { ...result, manualParcelOutputIndexes: { 0: 1 } });
  const download = await load("download");
  assert.match(download.headers.get("Content-Disposition") ?? "", /cleaned-parcels.geojson/);
  assert.deepEqual((await download.json()).features, [other, { ...parcel, geometry: repaired }]);
  const exported = await fetch(`${url}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetFormat: "geojson", targetCRS: "EPSG:4326" }),
  });
  assert.equal(exported.status, 200);
  const resumed = await (await fetch(reviewUrl)).json();
  assert.deepEqual(resumed.data.geometry, repaired);
  assert.equal(resumed.data.confirmed, true);
  assert.notEqual(resumed.data.revision, draft.revision);
});
