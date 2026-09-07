import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  cleanExpiredConversions,
  CONVERSION_RETENTION_SECONDS,
  createConversionDirectory,
  parseConversionOptions,
  processConversionJob,
  removeConversion,
} from "./conversion.service";

test("conversion options preserve format and CRS unless explicitly changed", () => {
  assert.deepEqual(parseConversionOptions("file.GEOJSON", {}), {
    inputFormat: "geojson",
    targetFormat: "geojson",
  });
  assert.deepEqual(
    parseConversionOptions("parcels.zip", {
      targetFormat: "dxf",
      sourceCRS: " epsg:32639 ",
      targetCRS: "EPSG:4326",
    }),
    {
      inputFormat: "shapefile",
      targetFormat: "dxf",
      sourceCRS: "EPSG:32639",
      targetCRS: "EPSG:4326",
    },
  );
});
test("conversion rejects missing CAD CRS, unsupported formats and non-scalar options", () => {
  assert.throws(() => parseConversionOptions("drawing.dxf", {}), {
    code: "SOURCE_CRS_REQUIRED",
  });
  for (const file of [
    "drawing.dwg",
    "drawing.dgn",
    "file.kml",
    "file.shp",
    "file.exe",
  ])
    assert.throws(() => parseConversionOptions(file, {}), {
      code: "UNSUPPORTED_CONVERSION_FORMAT",
    });
  for (const value of [[], {}, "EPSG:4326 --exec", "invalid", null])
    assert.throws(
      () => parseConversionOptions("a.json", { sourceCRS: value }),
      { code: "INVALID_SOURCE_CRS" },
    );
  assert.throws(
    () => parseConversionOptions("a.json", { targetFormat: "kml" }),
    { code: "UNSUPPORTED_CONVERSION_FORMAT" },
  );
});
test("conversion cleanup expires only old owned conversion directories", async () => {
  const old = await createConversionDirectory();
  const fresh = await createConversionDirectory();
  try {
    await fs.writeFile(path.join(old.directory, "output"), "test");
    const timestamp = new Date(
      Date.now() - (CONVERSION_RETENTION_SECONDS + 60) * 1000,
    );
    await fs.utimes(old.directory, timestamp, timestamp);
    await cleanExpiredConversions();
    await assert.rejects(fs.stat(old.directory), { code: "ENOENT" });
    assert.ok(await fs.stat(fresh.directory));
    await assert.rejects(
      removeConversion(path.dirname(fresh.directory)),
      /Invalid conversion directory/,
    );
  } finally {
    await removeConversion(old.directory);
    await removeConversion(fresh.directory);
  }
});

test("queue processor returns structured failures and cleans artifacts, without exposing unexpected diagnostics", async () => {
  const { id, directory } = await createConversionDirectory();
  const result = await processConversionJob(
    {
      id,
      directory,
      source: path.join(directory, "source"),
      userId: "owner",
      inputFormat: "geojson",
      targetFormat: "geojson",
    },
    async () => {
      throw new Error("private /server/path diagnostic");
    },
  );
  assert.deepEqual(result, {
    error: { code: "CONVERSION_FAILED", message: "Conversion failed." },
  });
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
