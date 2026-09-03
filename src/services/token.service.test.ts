import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middlewares/errorHandler";
import { createAccessToken, verifyAccessToken } from "./token.service";

test("creates and verifies a scoped access token", () => {
  process.env.JWT_ACCESS_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  const principal = {
    id: "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    roles: ["user"],
  };
  const token = createAccessToken(principal);
  assert.deepEqual(verifyAccessToken(token), principal);
});

test("rejects tampered access tokens", () => {
  process.env.JWT_ACCESS_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  assert.throws(
    () => verifyAccessToken("not.a.jwt"),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 401 &&
      error.code === "INVALID_ACCESS_TOKEN",
  );
});
