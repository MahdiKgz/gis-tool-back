import assert from "node:assert/strict";
import test from "node:test";
import { compactReport, issuePage } from "./public-report.service";
import type { DryRunReport, DryRunIssue } from "./dry-run.service";

const issue = (index: number): DryRunIssue => ({
  check: "precision", code: index % 2 ? "PRECISION" : "GAP", featureIndex: index,
  featureId: null, relatedFeatureIndex: null, relatedFeatureId: null, geometryType: "Polygon",
  location: { geometryCollectionPath: [], relatedGeometryCollectionPath: [], coordinatePath: [0, 1], relatedCoordinatePath: null, polygonPath: null, relatedPolygonPath: null },
  disposition: index === 51 ? "ManualReview" : "AutoRepairAvailable", details: { diagnostic: "x".repeat(1000) },
});
const report = {
  mode: "dry-run", valid: false, summary: { issuesFound: 100 }, issueGroups: [],
  affectedFeatureCollection: { type: "FeatureCollection", features: [] }, appliedOptions: {},
  issues: Array.from({ length: 100 }, (_, i) => issue(i)), checks: { verbose: "x".repeat(10000) },
} as unknown as DryRunReport;

test("compact reports preserve geometry and counts, retain stable manual issue indices and never mutate diagnostics", () => {
  const before = JSON.stringify(report);
  const compact = compactReport(report);
  assert.equal(compact.summary, report.summary);
  assert.equal(compact.affectedFeatureCollection, report.affectedFeatureCollection);
  assert.equal(compact.issues.length, 1);
  assert.equal(compact.issues[0]!.issueIndex, 51);
  assert.deepEqual(compact.issues[0]!.details, {});
  assert.deepEqual(compact.checks, {});
  assert.equal(compact.issueDetails.total, 100);
  assert.equal(JSON.stringify(report), before);
  assert.ok(JSON.stringify(compact).length < before.length / 20);
});
test("issue pages filter before pagination and retain original indices and complete details", () => {
  const page = issuePage(report, { page: "2", limit: "10", code: "PRECISION" });
  assert.equal(page.total, 50);
  assert.equal(page.items[0]!.issueIndex, 21);
  assert.equal(page.items.length, 10);
  assert.deepEqual(page.items[0]!.details, report.issues[21]!.details);
  assert.equal(issuePage(report, { page: "999" }).items.length, 0);
  for (const query of [{ limit: "101" }, { limit: "0" }, { page: "-1" }, { page: ["1"] }, { page: "9007199254740991", limit: "100" }, { code: ["GAP"] }])
    assert.throws(() => issuePage(report, query));
});
