import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middlewares/errorHandler";
import {
  normalizePhone,
  validateLoginInput,
  validateRegistrationInput,
} from "./auth.service";

test("normalizes Persian and Arabic digits in mobile numbers", () => {
  assert.equal(normalizePhone("۰۹۱۲ ۳۴۵ ۶۷۸۹"), "09123456789");
  assert.equal(normalizePhone("٠٩١٢-٣٤٥-٦٧٨٩"), "09123456789");
});

test("validates and trims registration input", () => {
  assert.deepEqual(
    validateRegistrationInput({
      name: "  Snap User  ",
      phone: "09123456789",
      password: "strong-password",
    }),
    { name: "Snap User", phone: "09123456789", password: "strong-password" },
  );
});

test("rejects malformed credentials before querying storage", () => {
  assert.throws(
    () => validateLoginInput({ phone: "123", password: "" }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});
