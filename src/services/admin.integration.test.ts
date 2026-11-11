import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { database } from "./database.service";
import { router } from "../routes/business.route";
import { createAccessToken } from "./token.service";
import { getAdminReports } from "./admin-reports.service";

test(
  "admin HTTP user management and reports preserve access boundaries, history and safe metadata",
  { skip: process.env.BUSINESS_INTEGRATION !== "1" },
  async (t) => {
    const ids: string[] = [];
    const createUser = async (name: string, roles = ["user"]) => {
      const user = await database.user.create({
        data: {
          name,
          phone: `09${randomInt(100000000, 999999999)}`,
          roles,
          passwordHash: "integration-only-no-login",
        },
      });
      ids.push(user.id);
      return user;
    };
    t.after(async () => {
      await database.uploadActivity.deleteMany({
        where: { userId: { in: ids } },
      });
      await database.uploadedFile.deleteMany({
        where: { userId: { in: ids } },
      });
      await database.user.deleteMany({ where: { id: { in: ids } } });
      await database.$disconnect();
    });
    const marker = `مدیریت ${randomUUID()}`;
    const admin = await createUser(`${marker} مدیر`, ["user", "admin"]);
    const user = await createUser(`${marker} نویسنده`, ["user", "writer"]);
    const outsider = await createUser(`${marker} عادی`);
    await database.user.update({
      where: { id: user.id },
      data: { planCode: "pro" },
    });
    const baseline = await getAdminReports(admin.id, {
      from: "2097-03-01",
      to: "2097-03-02",
    });
    const addFile = async (status: string, when: string, deleted = false) => {
      const id = randomUUID();
      const createdAt = new Date(when);
      const data = {
        id,
        userId: user.id,
        sizeInBytes: 100,
        identifiedIssues: 7,
        healedIssues: status === "completed" ? 5 : 0,
        healStatus: status,
        createdAt,
      };
      await database.uploadActivity.create({
        data: { ...data, deletedAt: deleted ? new Date() : null },
      });
      if (!deleted)
        await database.uploadedFile.create({
          data: {
            ...data,
            name: "نمونه",
            originalName: "sample.geojson",
            storedFileName: "private.geojson",
            storagePath: "/private/internal/path",
            mimeType: "application/geo+json",
          },
        });
      return id;
    };
    const deletedId = await addFile(
      "completed",
      "2097-03-01T00:00:00.000Z",
      true,
    );
    const failedId = await addFile("failed", "2097-03-02T23:59:59.999Z");
    await addFile("queued", "2097-03-02T01:00:00.000Z");
    await addFile("completed", "2097-03-03T00:00:00.000Z");
    for (let i = 0; i < 10; i++)
      await addFile(
        "dry-run-complete",
        `2097-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      );
    const app = express();
    app.use(express.json());
    app.use("/business", router);
    app.use(((err, _req, res, _next) =>
      res
        .status(err.statusCode ?? 500)
        .json({ code: err.code })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/business`;
    // An intentionally stale token claiming admin must never bypass the current database role.
    const headers = (id = admin.id) => ({
      Authorization: `Bearer ${createAccessToken({ id, roles: ["admin"] })}`,
      "Content-Type": "application/json",
    });
    const request = (path: string, options: RequestInit = {}) =>
      fetch(`${url}${path}`, { headers: headers(), ...options });

    await t.test(
      "only live admins may list, read, edit or report; validation rejects hostile input",
      async () => {
        for (const path of [
          "/admin/users",
          `/admin/users/${user.id}`,
          "/admin/reports",
        ]) {
          assert.equal((await fetch(`${url}${path}`)).status, 401);
          assert.equal(
            (await request(path, { headers: headers(outsider.id) })).status,
            403,
          );
        }
        assert.equal(
          (
            await request(`/admin/users/${user.id}`, {
              method: "PATCH",
              headers: headers(outsider.id),
              body: JSON.stringify({ name: "نام تازه", phone: user.phone }),
            })
          ).status,
          403,
        );
        for (const path of [
          "/admin/users?role=superadmin",
          "/admin/users?limit=51",
          "/admin/users?search=a&search=b",
          "/admin/users/invalid",
          "/admin/reports?from=2097-02-30",
          "/admin/reports?from=2024-01-01&to=2025-01-01",
        ])
          assert.equal((await request(path)).status, 400, path);
        assert.equal(
          (await request(`/admin/users/${randomUUID()}`)).status,
          404,
        );
      },
    );

    await t.test(
      "list and detail show cumulative usage including deleted history without internal paths or secrets",
      async () => {
        const response = await request(
          `/admin/users?search=${encodeURIComponent(marker)}&plan=pro&role=writer&limit=1`,
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const page = (await response.json()).data;
        assert.equal(page.pagination.total, 1);
        assert.equal(page.items[0].id, user.id);
        assert.deepEqual(page.items[0].usage, {
          uploads: 14,
          bytes: 1400,
          identifiedIssues: 98,
          healedIssues: 10,
        });
        assert.equal(page.items[0].storedFiles, 13);
        assert.equal("passwordHash" in page.items[0], false);
        const detail = (await (await request(`/admin/users/${user.id}`)).json())
          .data;
        assert.deepEqual(detail.user, page.items[0]);
        assert.equal(detail.recentFiles.length, 10);
        assert.equal(
          detail.recentFiles.some(
            (file: { id: string }) => file.id === deletedId,
          ),
          false,
        );
        assert.ok(
          detail.recentFiles[0].createdAt > detail.recentFiles[1].createdAt,
        );
        assert.deepEqual(Object.keys(detail.recentFiles[0]).sort(), [
          "createdAt",
          "healStatus",
          "healedIssues",
          "id",
          "identifiedIssues",
          "name",
          "originalName",
          "sizeInBytes",
        ]);
        const phoneSearch = user.phone.replace(
          /\d/g,
          (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]!,
        );
        const byPhone = (
          await (
            await request(
              `/admin/users?search=${encodeURIComponent(phoneSearch)}`,
            )
          ).json()
        ).data;
        assert.equal(byPhone.items[0].id, user.id);
      },
    );

    await t.test(
      "profile editing normalizes mobile digits, rejects duplicates and privilege keys, and preserves plan, password and roles",
      async () => {
        for (const key of ["roles", "planCode", "password", "passwordHash"])
          assert.equal(
            (
              await request(`/admin/users/${user.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: "نام تازه",
                  phone: user.phone,
                  [key]: "admin",
                }),
              })
            ).status,
            400,
          );
        const duplicate = await request(`/admin/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: "نام تازه", phone: admin.phone }),
        });
        assert.equal(duplicate.status, 409);
        assert.equal((await duplicate.json()).code, "PHONE_ALREADY_EXISTS");
        const phone = `09${randomInt(100000000, 999999999)}`;
        const updated = await request(`/admin/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: "  نام ویرایش‌شده  ",
            phone: phone.replace(
              /\d/g,
              (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]!,
            ),
          }),
        });
        assert.equal(updated.status, 200);
        const item = (await updated.json()).data;
        assert.equal(item.name, "نام ویرایش‌شده");
        assert.equal(item.phone, phone);
        assert.equal(item.usage.uploads, 14);
        const persisted = await database.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        assert.deepEqual(persisted.roles, ["user", "writer"]);
        assert.equal(persisted.planCode, "pro");
        assert.equal(persisted.passwordHash, "integration-only-no-login");
        const writerResponse = await request(
          `/admin/users/${user.id}/writer-role`,
          { method: "PATCH", body: JSON.stringify({ enabled: false }) },
        );
        assert.equal(writerResponse.status, 200);
        assert.deepEqual((await writerResponse.json()).data.roles, ["user"]);
      },
    );

    await t.test(
      "reports include deleted activity and inclusive UTC limits, zero days and safe retained failure metadata",
      async () => {
        const response = await request(
          "/admin/reports?from=2097-03-01&to=2097-03-02",
        );
        assert.equal(response.status, 200);
        const report = (await response.json()).data;
        assert.deepEqual(report.range, {
          from: "2097-03-01",
          to: "2097-03-02",
          timeZone: "UTC",
        });
        for (const [key, delta] of Object.entries({
          uploads: 3,
          bytes: 300,
          identifiedIssues: 21,
          healedIssues: 5,
          storedFiles: 2,
          deletedFiles: 1,
          completed: 1,
          failed: 1,
          processing: 1,
        }))
          assert.equal(
            report.summary[key] -
              baseline.summary[key as keyof typeof baseline.summary],
            delta,
            key,
          );
        assert.equal(report.daily[0].uploads - baseline.daily[0]!.uploads, 1);
        assert.equal(
          report.daily[0].completed - baseline.daily[0]!.completed,
          1,
        );
        assert.equal(report.daily[1].uploads - baseline.daily[1]!.uploads, 2);
        const failure = report.recentFailures.find(
          (file: { id: string }) => file.id === failedId,
        );
        assert.equal(failure.user.id, user.id);
        assert.equal(failure.user.name, "نام ویرایش‌شده");
        assert.deepEqual(Object.keys(failure).sort(), [
          "createdAt",
          "healStatus",
          "healedIssues",
          "id",
          "identifiedIssues",
          "name",
          "originalName",
          "sizeInBytes",
          "user",
        ]);
        assert.equal(
          report.plans.reduce(
            (total: number, plan: { count: number }) => total + plan.count,
            0,
          ),
          report.summary.users,
        );
        const empty = (
          await (
            await request("/admin/reports?from=2097-04-01&to=2097-04-03")
          ).json()
        ).data;
        assert.equal(empty.daily.length, 3);
        assert.equal(empty.daily[0].date, "2097-04-01");
        assert.equal(
          empty.daily.reduce(
            (sum: number, day: { uploads: number }) => sum + day.uploads,
            0,
          ),
          empty.summary.uploads,
        );
        await database.user.update({
          where: { id: admin.id },
          data: { roles: ["user"] },
        });
        assert.equal((await request("/admin/reports")).status, 403);
        assert.equal(
          (
            await request(`/admin/users/${user.id}`, {
              method: "PATCH",
              body: JSON.stringify({ name: "نام تازه", phone: user.phone }),
            })
          ).status,
          403,
        );
      },
    );
  },
);
