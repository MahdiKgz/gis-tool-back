import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createConversionHandlers,
  type ConversionJobView,
} from "./conversion.controller";
import { requireAuthentication } from "../middlewares/auth.middleware";
import { globalErrorHandler } from "../middlewares/errorHandler";
import { createAccessToken } from "../services/token.service";
import {
  saveAnalysis,
  markAnalysisCompleted,
  deleteAnalysis,
} from "../services/analysis-store.service";
import type { DryRunReport } from "../services/dry-run.service";
import {
  runConversion,
  removeConversion,
  SYNC_CONVERSION_BYTES,
} from "../services/conversion.service";

const integration =
  process.env.CONVERSION_INTEGRATION === "1" ? test : test.skip;
integration(
  "exports stored healed geometry in supported formats and CRS, protects ownership and queues large outputs",
  async () => {
    const previousSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET =
      "healed-export-test-secret-with-more-than-32-characters";
    const jobs = new Map<string, ConversionJobView>();
    const handlers = createConversionHandlers({
      convert: runConversion,
      enqueue: async (task) => {
        jobs.set(task.id, { data: task, state: "waiting" });
      },
      getJob: async (id) => jobs.get(id) ?? null,
    });
    const app = express();
    app.use(express.json());
    app.post(
      "/heal/:jobId/export",
      requireAuthentication,
      handlers.exportHealed,
    );
    app.get("/convert/:id/download", requireAuthentication, handlers.download);
    app.use(globalErrorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const analysis = await saveAnalysis(
      {
        fileName: "input.geojson",
        originalName: "input.geojson",
        filePath: "/tmp/unused-export-input.geojson",
        size: 0,
        tolerance: 25,
      },
      { summary: {}, issues: [] } as unknown as DryRunReport,
      undefined,
      "owner",
    );
    const output = path.resolve(
      "uploads/cleaned_files",
      `${analysis.id}-export.geojson`,
    );
    const original = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "parcel" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [51, 35],
                [51.01, 35],
                [51.01, 35.01],
                [51, 35.01],
                [51, 35],
              ],
            ],
          },
        },
      ],
    });
    const request = (body: unknown, owner: string | null = "owner") =>
      fetch(`${base}/heal/${analysis.id}/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(owner
            ? {
                Authorization: `Bearer ${createAccessToken({ id: owner, roles: ["user"] })}`,
              }
            : {}),
        },
        body: JSON.stringify(body),
      });
    try {
      assert.equal(
        (await request({ targetFormat: "geojson" }, null)).status,
        401,
      );
      assert.equal(
        (await request({ targetFormat: "geojson" }, "other")).status,
        404,
      );
      assert.equal((await request({ targetFormat: "geojson" })).status, 409);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, original);
      await markAnalysisCompleted(analysis.id, {
        outputFilePath: output,
        outputFileName: path.basename(output),
      });
      assert.equal((await request({ targetFormat: "dwg" })).status, 400);
      assert.equal(
        (await request({ targetFormat: "geojson", sourceCRS: "EPSG:32639" }))
          .status,
        400,
      );
      for (const format of ["geojson", "shapefile", "dxf"]) {
        const response = await request({
          targetFormat: format,
          targetCRS: "EPSG:32639",
        });
        assert.equal(
          response.status,
          200,
          await (response.status !== 200
            ? response.text()
            : Promise.resolve("")),
        );
        const report = JSON.parse(
          decodeURIComponent(response.headers.get("x-conversion-result")!),
        );
        assert.equal(report.sourceCRS, "EPSG:4326");
        assert.equal(report.targetCRS, "EPSG:32639");
        assert.equal(report.features, 1);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (format === "shapefile")
          assert.equal(bytes.subarray(0, 2).toString(), "PK");
        if (format === "dxf") assert.match(bytes.toString(), /ENTITIES/);
        if (format === "geojson")
          assert.ok(
            JSON.parse(bytes.toString()).features[0].geometry
              .coordinates[0][0][0] > 100000,
          );
        assert.equal(await fs.readFile(output, "utf8"), original);
      }
      await fs.appendFile(output, " ".repeat(SYNC_CONVERSION_BYTES));
      const queued = await request({
        targetFormat: "geojson",
        targetCRS: "EPSG:4326",
      });
      assert.equal(queued.status, 202);
      const id = ((await queued.json()) as any).data.jobId;
      const job = jobs.get(id)!;
      assert.equal(job.data.userId, "owner");
      await fs.rm(output); // The queued task owns a copy and survives removal of the source artifact.
      job.result = await runConversion(job.data);
      job.state = "completed";
      const download = await fetch(`${base}/convert/${id}/download`, {
        headers: {
          Authorization: `Bearer ${createAccessToken({ id: "owner", roles: ["user"] })}`,
        },
      });
      assert.equal(download.status, 200);
      assert.equal(((await download.json()) as any).features.length, 1);
      assert.equal((await request({ targetFormat: "geojson" })).status, 410);
    } finally {
      await deleteAnalysis(analysis.id);
      await fs.rm(output, { force: true });
      for (const job of jobs.values())
        await removeConversion(job.data.directory);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousSecret;
    }
  },
);
