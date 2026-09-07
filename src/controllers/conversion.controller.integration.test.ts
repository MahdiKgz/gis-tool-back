import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import {
  createConversionHandlers,
  ConversionJobView,
} from "./conversion.controller";
import { conversionUpload } from "../routes/conversion.route";
import { requireAuthentication } from "../middlewares/auth.middleware";
import { globalErrorHandler } from "../middlewares/errorHandler";
import { createAccessToken } from "../services/token.service";
import {
  CONVERSION_ROOT,
  conversionOutput,
  removeConversion,
  runConversion,
} from "../services/conversion.service";

const integration =
  process.env.CONVERSION_INTEGRATION === "1" ? test : test.skip;
integration(
  "HTTP multipart upload, binary ZIP download, queue receipt/status and authentication",
  async () => {
    const priorSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET =
      "conversion-test-only-secret-with-more-than-32-characters";
    const jobs = new Map<string, ConversionJobView>();
    const handlers = createConversionHandlers({
      convert: runConversion,
      enqueue: async (task) => {
        jobs.set(task.id, { data: task, state: "waiting" });
      },
      getJob: async (id) => jobs.get(id) ?? null,
    });
    const app = express();
    app.post(
      "/convert",
      requireAuthentication,
      conversionUpload,
      handlers.upload,
    );
    app.get("/convert/:id", requireAuthentication, handlers.status);
    app.get("/convert/:id/download", requireAuthentication, handlers.download);
    app.use(globalErrorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const authorization = `Bearer ${createAccessToken({ id: "conversion-owner", roles: ["user"] })}`;
    const polygon = JSON.stringify({
      type: "Feature",
      properties: { name: "test" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [51, 35],
            [51.1, 35],
            [51.1, 35.1],
            [51, 35.1],
            [51, 35],
          ],
        ],
      },
    });
    const multipart = (contents: string) => {
      const form = new FormData();
      form.set("file", new Blob([contents]), "input.geojson");
      form.set("targetFormat", "shapefile");
      return form;
    };
    try {
      const directoriesBefore = await fs
        .readdir(CONVERSION_ROOT)
        .catch(() => []);
      const anonymous = await fetch(`${base}/convert`, {
        method: "POST",
        body: multipart(polygon),
      });
      assert.equal(anonymous.status, 401);
      assert.deepEqual(
        await fs.readdir(CONVERSION_ROOT).catch(() => []),
        directoriesBefore,
      );
      const small = await fetch(`${base}/convert`, {
        method: "POST",
        headers: { authorization },
        body: multipart(polygon),
      });
      assert.equal(small.status, 200);
      assert.match(small.headers.get("content-disposition")!, /converted.zip/);
      const bytes = Buffer.from(await small.arrayBuffer());
      assert.equal(bytes.subarray(0, 2).toString(), "PK");
      assert.equal(
        JSON.parse(
          decodeURIComponent(small.headers.get("x-conversion-result")!),
        ).features,
        1,
      );
      const queued = await fetch(`${base}/convert`, {
        method: "POST",
        headers: { authorization },
        body: multipart(polygon + " ".repeat(5 * 1024 * 1024)),
      });
      assert.equal(queued.status, 202);
      const id = ((await queued.json()) as any).data.jobId;
      const job = jobs.get(id)!;
      assert.equal(job.data.userId, "conversion-owner");
      const waiting = await fetch(`${base}/convert/${id}`, {
        headers: { authorization },
      });
      assert.equal(((await waiting.json()) as any).data.status, "processing");
      const other = await fetch(`${base}/convert/${id}`, {
        headers: {
          authorization: `Bearer ${createAccessToken({ id: "other-owner", roles: ["user"] })}`,
        },
      });
      assert.equal(other.status, 404);
      job.result = await runConversion(job.data);
      job.state = "completed";
      const ready = await fetch(`${base}/convert/${id}`, {
        headers: { authorization },
      });
      assert.equal(((await ready.json()) as any).data.status, "completed");
      const download = await fetch(`${base}/convert/${id}/download`, {
        headers: { authorization },
      });
      assert.equal(download.status, 200);
      assert.equal(
        Buffer.from(await download.arrayBuffer())
          .subarray(0, 2)
          .toString(),
        "PK",
      );
      assert.ok(await fs.stat(conversionOutput(job.data)));
    } finally {
      for (const job of jobs.values())
        await removeConversion(job.data.directory);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (priorSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = priorSecret;
    }
  },
);
