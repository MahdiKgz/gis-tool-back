import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { cadImportReport } from "./cad-import-report";
import { analyzeGeoJson } from "./dry-run.service";
import { compactReport } from "./public-report.service";

test("CAD warning policy accepts known diagnostics and rejects unknown reader warnings", () => {
  execFileSync("python3", ["scripts/test_cad_warnings.py"], { stdio: "pipe" });
});
test("CAD diagnostics survive dry-run and compact responses without altering topology counts", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [51, 35] },
        properties: {},
      },
    ],
  };
  const metadata = {
    sourceCrs: "EPSG:32639",
    targetCrs: "EPSG:4326",
    partial: false,
    warnings: [
      {
        code: "CAD_MISSING_BLOCK",
        message: "Block X does not exist",
        occurrences: 1,
      },
    ],
  };
  const baseline = analyzeGeoJson(input, { toleranceMillimeters: 25 });
  const report = analyzeGeoJson(
    { ...input, snapgisCadImport: metadata },
    { toleranceMillimeters: 25 },
  );
  assert.equal(report.cadImport?.partial, true);
  assert.deepEqual(report.summary, baseline.summary);
  assert.deepEqual(compactReport(report).cadImport, report.cadImport);
  assert.equal(
    cadImportReport({ ...metadata, warnings: [{ code: "arbitrary" }] }),
    undefined,
  );
});
