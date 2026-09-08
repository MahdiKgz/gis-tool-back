import type { StoredAnalysis } from "../services/analysis-store.service";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Request, Response, NextFunction } from "express";
import {
  createConversionHandlers,
  ConversionJobView,
} from "./conversion.controller";
import {
  conversionOutput,
  createConversionDirectory,
  removeConversion,
  ConversionTask,
  SYNC_CONVERSION_BYTES,
} from "../services/conversion.service";

const report = {
  features: 1,
  sourceCRS: "EPSG:4326",
  targetCRS: "EPSG:4326",
  warnings: [],
};
async function fixture(size: number) {
  const { id, directory } = await createConversionDirectory();
  const source = path.join(directory, "input.geojson");
  await fs.writeFile(source, "{}");
  const task: ConversionTask = {
    id,
    directory,
    source,
    userId: "owner",
    inputFormat: "geojson",
    targetFormat: "geojson",
  };
  const req = {
    file: { originalname: "a.geojson", path: source, size },
    body: {},
    auth: { userId: "owner" },
    params: { id },
  } as unknown as Request;
  const emitter = new EventEmitter();
  let body: any;
  let status = 200;
  let downloaded: string | undefined;
  const res = Object.assign(emitter, {
    headersSent: false,
    writableFinished: false,
    setHeader() {},
    status(value: number) {
      status = value;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
    download(file: string, _name: string, callback: (err?: Error) => void) {
      downloaded = file;
      callback();
    },
  }) as unknown as Response;
  return { req, res, task, capture: () => ({ body, status, downloaded }) };
}
const next: NextFunction = (error) => {
  if (error) throw error;
};

test("small conversion responds with binary output then cleans its upload without enqueueing", async () => {
  const { req, res, task, capture } = await fixture(SYNC_CONVERSION_BYTES);
  const handlers = createConversionHandlers({
    convert: async (value) => {
      await fs.writeFile(conversionOutput(value), "converted");
      return report;
    },
    enqueue: async () => assert.fail("must not queue"),
    getJob: async () => null,
  });
  await handlers.upload(req, res, next);
  assert.equal(capture().status, 200);
  assert.equal(capture().downloaded, conversionOutput(task));
  await assert.rejects(fs.stat(task.directory), { code: "ENOENT" });
});
test("large conversion returns 202 and keeps the file for its owner-scoped job", async () => {
  const { req, res, task, capture } = await fixture(SYNC_CONVERSION_BYTES + 1);
  let queued: ConversionTask | undefined;
  const handlers = createConversionHandlers({
    convert: async () => assert.fail("must queue"),
    enqueue: async (value) => {
      queued = value;
    },
    getJob: async () => null,
  });
  try {
    await handlers.upload(req, res, next);
    assert.equal(capture().status, 202);
    assert.equal(capture().body.data.jobId, task.id);
    assert.equal(queued?.userId, "owner");
    assert.ok(await fs.stat(task.source));
  } finally {
    await removeConversion(task.directory);
  }
});
test("validation and queue failures delete temporary uploads", async () => {
  for (const invalid of [true, false]) {
    const { req, res, task } = await fixture(SYNC_CONVERSION_BYTES + 1);
    if (invalid) req.body.targetCRS = "bad";
    const handlers = createConversionHandlers({
      convert: async () => report,
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
      getJob: async () => null,
    });
    let failure: unknown;
    await handlers.upload(req, res, (error) => {
      failure = error;
    });
    assert.ok(failure);
    await assert.rejects(fs.stat(task.directory), { code: "ENOENT" });
  }
});
test("status and download never expose another user's job", async () => {
  const { req, res, task, capture } = await fixture(1);
  const job: ConversionJobView = {
    data: { ...task, userId: "someone-else" },
    state: "completed",
    result: report,
  };
  const handlers = createConversionHandlers({
    convert: async () => report,
    enqueue: async () => {},
    getJob: async () => job,
  });
  try {
    for (const handler of [handlers.status, handlers.download]) {
      let failure: any;
      await handler(req, res, (error) => {
        failure = error;
      });
      assert.equal(failure.code, "CONVERSION_NOT_FOUND");
    }
    assert.equal(capture().downloaded, undefined);
    assert.equal(capture().body, undefined);
  } finally {
    await removeConversion(task.directory);
  }
});
test("download rejects pending and expired outputs", async () => {
  const { req, res, task } = await fixture(1);
  let state = "active";
  const handlers = createConversionHandlers({
    convert: async () => report,
    enqueue: async () => {},
    getJob: async () => ({ data: task, state, result: report }),
  });
  try {
    let failure: any;
    await handlers.download(req, res, (error) => {
      failure = error;
    });
    assert.equal(failure.code, "CONVERSION_NOT_READY");
    state = "completed";
    await handlers.download(req, res, (error) => {
      failure = error;
    });
    assert.equal(failure.code, "CONVERSION_EXPIRED");
  } finally {
    await removeConversion(task.directory);
  }
});

test("job retention is enforced before scheduled disk cleanup", async () => {
  const { req, res, task } = await fixture(1);
  const handlers = createConversionHandlers({
    convert: async () => report,
    enqueue: async () => {},
    getJob: async () => ({
      data: task,
      state: "completed",
      result: report,
      expiresAt: Date.now() - 1,
    }),
  });
  try {
    let failure: any;
    await handlers.status(req, res, (error) => {
      failure = error;
    });
    assert.equal(failure.code, "CONVERSION_EXPIRED");
  } finally {
    await removeConversion(task.directory);
  }
});

test("stored exports reject unfinished jobs, unsupported formats and source CRS relabeling before conversion", async () => {
  const { req, res, task } = await fixture(0);
  req.params.jobId = "job";
  const analysis = {
    healStatus: "processing",
    healResult: {
      outputFilePath: path.resolve("uploads/cleaned_files/test-export.geojson"),
    },
  } as StoredAnalysis;
  const handlers = createConversionHandlers({
    getOwnedAnalysis: async () => analysis,
    convert: async () => assert.fail("must not convert invalid requests"),
    enqueue: async () => assert.fail("must not enqueue invalid requests"),
    getJob: async () => null,
  });
  try {
    await assert.rejects(handlers.exportHealed(req, res, next), {
      code: "CONVERSION_NOT_READY",
    });
    analysis.healStatus = "completed";
    req.body = { targetFormat: "dwg" };
    await assert.rejects(handlers.exportHealed(req, res, next), {
      code: "UNSUPPORTED_CONVERSION_FORMAT",
    });
    req.body = { targetFormat: "geojson", sourceCRS: "EPSG:32639" };
    await assert.rejects(handlers.exportHealed(req, res, next), {
      code: "INVALID_SOURCE_CRS",
    });
  } finally {
    await removeConversion(task.directory);
  }
});
