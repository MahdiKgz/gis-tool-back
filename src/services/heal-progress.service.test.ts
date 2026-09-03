import assert from "node:assert/strict";
import test from "node:test";
import {
  createHealingProgress,
  parseHealingProgress,
} from "./heal-progress.service";

test("normalizes staged healing progress and live issue counters", () => {
  const progress = createHealingProgress(120, "healing", {
    gap: 3.8,
    sliver: -2,
    kink: Number.NaN,
    spike: 4,
  });
  assert.deepEqual(progress, {
    value: 100,
    stage: "healing",
    issueCounts: { gap: 3, sliver: 0, kink: 0, spike: 4 },
  });
  assert.deepEqual(parseHealingProgress(progress), progress);
  assert.equal(parseHealingProgress({ value: 30, stage: "unknown" }), null);
  assert.equal(parseHealingProgress(30), null);
});
