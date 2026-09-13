import assert from "node:assert/strict";
import test from "node:test";
import { Request, Response } from "express";
import { AppError, globalErrorHandler } from "./errorHandler";

for (const [status, code] of [[401, "REFRESH_SESSION_REQUIRED"], [409, "HEALING_NOT_COMPLETE"]] as const) {
  test(`${code} preserves the response without logging a server failure`, (t) => {
    const errorLog = t.mock.method(console, "error", () => {});
    const warningLog = t.mock.method(console, "warn", () => {});
    let responseStatus = 0;
    let body: unknown;
    const response = {
      status(value: number) { responseStatus = value; return this; },
      json(value: unknown) { body = value; },
    } as Response;
    globalErrorHandler(new AppError(status, "Expected response", code),
      { method: "POST", path: "/api/example", originalUrl: "/api/example?secret=hidden" } as Request,
      response, () => {});
    assert.equal(responseStatus, status);
    assert.deepEqual(body, { success: false, code, message: "Expected response" });
    assert.equal(errorLog.mock.callCount(), 0);
    assert.deepEqual(warningLog.mock.calls[0]?.arguments, ["API request rejected", {
      method: "POST", path: "/api/example", status, code,
    }]);
  });
}

test("unexpected failures retain their error and stack in server logs", (t) => {
  const log = t.mock.method(console, "error", () => {});
  const error = new Error("Unexpected failure");
  let responseStatus = 0;
  const response = {
    status(value: number) { responseStatus = value; return this; },
    json() {},
  } as unknown as Response;
  globalErrorHandler(error, {} as Request, response, () => {});
  assert.equal(responseStatus, 500);
  assert.equal(log.mock.calls[0]?.arguments[1], error);
});
