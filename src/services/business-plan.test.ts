import assert from "node:assert/strict";
import test from "node:test";
import { PLANS, parsePlanCode, planByCode } from "./business-plan.service";
import {
  parseBusinessId,
  parseColleaguePhone,
  parseCompanyName,
} from "./company.service";

test("only the three existing plans are assignable, with three seats on the company plan", () => {
  assert.deepEqual(
    PLANS.map((p) => p.code),
    ["starter", "pro", "advanced"],
  );
  assert.equal(planByCode("advanced").employeeLimit, 3);
  for (const value of ["free", "admin", "", null, {}, ["advanced"]])
    assert.throws(() => parsePlanCode(value));
});
test("company input validation supports Persian phone digits and rejects unsafe identifiers/names", () => {
  assert.equal(parseColleaguePhone("۰۹۱۲ ۳۴۵ ۶۷۸۹"), "09123456789");
  assert.equal(parseCompanyName("  شرکت نقشه  "), "شرکت نقشه");
  for (const value of ["123", null, ["09123456789"]])
    assert.throws(() => parseColleaguePhone(value));
  for (const value of ["", "x", "x".repeat(151), "hello\nworld"])
    assert.throws(() => parseCompanyName(value));
  for (const value of ["1", "'; DROP TABLE users", [], null])
    assert.throws(() => parseBusinessId(value));
});
