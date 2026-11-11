import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middlewares/errorHandler";
import { normalizeAccountEmail, resetAccountPassword } from "./account-recovery.service";

test("normalizes the same email for verification and recovery", () => {
  assert.equal(normalizeAccountEmail("  GIS.User+snap@Example.COM  "), "gis.user+snap@example.com");
});

test("rejects malformed addresses and multiple SMTP recipients", () => {
  for (const address of [
    "a@example.com,b@example.com",
    "a@example.com\nBcc: b@example.com",
    "a..b@example.com",
    "a@-example.com",
    "a@@example.com",
    `${"a".repeat(65)}@example.com`,
  ]) {
    assert.throws(
      () => normalizeAccountEmail(address),
      (error) => error instanceof AppError && error.code === "INVALID_EMAIL",
    );
  }
});

test("rejects malformed links and invalid new passwords before accessing the database", async () => {
  await assert.rejects(
    resetAccountPassword({ token: "short-token", password: "new-password" }),
    (error) => error instanceof AppError && error.code === "INVALID_EMAIL_LINK",
  );
  await assert.rejects(
    resetAccountPassword({ token: "a".repeat(43), password: "آ".repeat(65) }),
    (error) => error instanceof AppError && error.code === "INVALID_PASSWORD",
  );
});
