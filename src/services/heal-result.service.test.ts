import assert from "node:assert/strict";
import test from "node:test";
import { StoredAnalysis } from "./analysis-store.service";
import {
  buildPublicHealResult,
  resolveHealedOutput,
} from "./heal-result.service";

const analysis = {
  id: "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
  healResult: {
    outputFileName: "cleaned-parcels.geojson",
    outputFilePath: "uploads/cleaned_files/cleaned-parcels.geojson",
    gapsClosed: 2,
    overlapsHealed: 1,
    spikesRemoved: 3,
    originalSizeInBytes: 100,
    optimizedSizeInBytes: 80,
  },
} as unknown as StoredAnalysis;

test("builds a public result without exposing the server file path", () => {
  const result = buildPublicHealResult(analysis);

  assert.ok(result);
  assert.equal(result.repairsApplied, 6);
  assert.deepEqual(result.output, {
    fileName: "cleaned-parcels.geojson",
    previewPath: `/heal/${analysis.id}/output`,
    downloadPath: `/heal/${analysis.id}/download`,
  });
  assert.equal("outputFilePath" in result, false);
});

test("only resolves output files inside the cleaned output directory", () => {
  const safe = resolveHealedOutput(analysis);
  assert.ok(safe?.filePath.endsWith("uploads/cleaned_files/cleaned-parcels.geojson"));

  const unsafe = resolveHealedOutput({
    ...analysis,
    healResult: {
      outputFileName: "passwd",
      outputFilePath: "/etc/passwd",
    },
  });
  assert.equal(unsafe, null);
});
