import assert from "node:assert/strict";
import test from "node:test";
import { NextFunction, Request, Response } from "express";
import { AppError } from "./errorHandler";
import { requireAuthentication } from "./auth.middleware";
import { createAccessToken } from "../services/token.service";

process.env.JWT_ACCESS_SECRET =
  "test-secret-that-is-longer-than-thirty-two-characters";

const executeMiddleware = (authorization?: string) => {
  let nextError: unknown;
  let nextCalled = false;
  const request = {
    header(name: string) {
      return name === "authorization" ? authorization : undefined;
    },
  } as Request;
  const next = ((error?: unknown) => {
    nextCalled = true;
    nextError = error;
  }) as NextFunction;

  requireAuthentication(request, {} as Response, next);
  return { request, nextCalled, nextError };
};

test("attaches the verified access-token identity to an authenticated request", () => {
  const token = createAccessToken({
    id: "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    roles: ["user"],
  });
  const result = executeMiddleware(`Bearer ${token}`);

  assert.equal(result.nextCalled, true);
  assert.equal(result.nextError, undefined);
  assert.deepEqual(result.request.auth, {
    userId: "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    roles: ["user"],
  });
});

test("rejects requests without a Bearer access token", () => {
  const result = executeMiddleware();

  assert.ok(result.nextError instanceof AppError);
  assert.equal(result.nextError.statusCode, 401);
  assert.equal(result.nextError.code, "AUTHENTICATION_REQUIRED");
});
