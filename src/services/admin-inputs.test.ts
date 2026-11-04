import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminProfile, parseReportRange } from "./admin-inputs";

test("admin profile edits normalize Persian mobile digits and preserve only supported profile fields", () => {
  assert.deepEqual(
    parseAdminProfile({ name: "  کاربر نقشه  ", phone: "۰۹۱۲ ۳۴۵ ۶۷۸۹" }),
    { name: "کاربر نقشه", phone: "09123456789" },
  );
  for (const body of [
    null,
    [],
    {},
    { name: "x", phone: "09123456789" },
    { name: "a\nb", phone: "09123456789" },
    { name: "x".repeat(101), phone: "09123456789" },
    { name: "کاربر", phone: "123" },
  ])
    assert.throws(() => parseAdminProfile(body));
  for (const key of [
    "roles",
    "planCode",
    "password",
    "passwordHash",
    "id",
    "__proto__",
  ])
    assert.throws(
      () =>
        parseAdminProfile(
          JSON.parse(`{"name":"کاربر","phone":"09123456789","${key}":"admin"}`),
        ),
      { code: "INVALID_PROFILE_FIELDS" },
    );
});

test("admin report date range uses inclusive UTC days, defaults to 30 days, and handles leap boundaries", () => {
  const range = parseReportRange({}, new Date("2026-11-04T23:59:59.999Z"));
  assert.equal(range.from, "2026-10-06");
  assert.equal(range.to, "2026-11-04");
  assert.equal(range.days, 30);
  assert.equal(range.endExclusive.toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(
    parseReportRange({ from: "2024-02-29", to: "2024-02-29" }).days,
    1,
  );
  assert.equal(
    parseReportRange({ from: "2024-01-01", to: "2024-12-31" }).days,
    366,
  );
  assert.equal(parseReportRange({ to: "2024-03-01" }).from, "2024-02-01");
  for (const query of [
    { from: "2026-02-29" },
    { to: "2026-04-31" },
    { from: ["2026-01-01"] },
    { to: "2026-11-04T01:00:00Z" },
    { from: "2026-01-02", to: "2026-01-01" },
    { from: "2024-01-01", to: "2025-01-01" },
  ])
    assert.throws(() => parseReportRange(query), {
      code: "INVALID_REPORT_RANGE",
    });
});
