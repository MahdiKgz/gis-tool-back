import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middlewares/errorHandler";
import { parseUploadName } from "./upload-name.service";

test("parseUploadName trims a valid display name", () => {
  assert.equal(parseUploadName("  Parcel boundaries  "), "Parcel boundaries");
});

test("parseUploadName rejects missing, short, long, and control-character names", () => {
  for (const value of [undefined, " ", "a", "a".repeat(151), "roads\nlayer"]) {
    assert.throws(
      () => parseUploadName(value),
      (error) =>
        error instanceof AppError &&
        error.statusCode === 400 &&
        error.code === "INVALID_UPLOAD_NAME",
    );
  }
});
