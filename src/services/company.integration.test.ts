import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { database } from "./database.service";
import { AppError } from "../middlewares/errorHandler";
import { router } from "../routes/business.route";
import { createAccessToken } from "./token.service";
import { getUserPlan } from "./business-plan.service";
import * as company from "./company.service";
import * as uploads from "./upload-record.service";

const errorCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

test(
  "company plans, permissions, concurrency and immutable upload attribution",
  { skip: process.env.BUSINESS_INTEGRATION !== "1" },
  async (t) => {
    const ids: string[] = [];
    const createUser = async (name: string, roles = ["user"]) => {
      const user = await database.user.create({
        data: {
          name: `Business test ${name} ${randomUUID()}`,
          phone: `09${randomInt(100000000, 999999999)}`,
          passwordHash: "integration-only-no-login",
          roles,
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
      await database.planAssignment.deleteMany({
        where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
      });
      await database.company.deleteMany({ where: { ownerId: { in: ids } } });
      await database.user.deleteMany({ where: { id: { in: ids } } });
      await database.$disconnect();
    });
    const admin = await createUser("admin", ["admin"]);
    const owner = await createUser("owner");
    const otherOwner = await createUser("other owner");
    const members = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createUser(`member ${i}`)),
    );
    const upload = (userId: string) =>
      uploads.createUploadRecord({
        id: randomUUID(),
        userId,
        name: "test",
        originalName: "test.geojson",
        storedFileName: "test.geojson",
        storagePath: "/test/no-object-created",
        mimeType: "application/geo+json",
        sizeInBytes: 1234,
        identifiedIssues: 7,
      });

    await t.test(
      "new accounts default to starter and only current admins can assign plans",
      async () => {
        assert.equal(owner.planCode, "starter");
        assert.equal((await getUserPlan(owner.id)).code, "starter");
        await assert.rejects(
          company.assignUserPlan(owner.id, owner.id, "advanced"),
          errorCode("ADMIN_REQUIRED"),
        );
        await company.assignUserPlan(admin.id, owner.id, "advanced");
        await company.assignUserPlan(admin.id, otherOwner.id, "advanced");
        await company.assignUserPlan(admin.id, owner.id, "advanced");
        assert.equal(
          await database.planAssignment.count({ where: { userId: owner.id } }),
          1,
        );
        assert.equal(
          (await company.getBusinessContext(owner.id)).company?.role,
          "owner",
        );
        const page = await company.listPlanUsers(admin.id, {
          search: owner.phone,
          plan: "advanced",
          limit: 1,
        });
        assert.equal(page.pagination.total, 1);
        assert.equal(page.items[0]?.id, owner.id);
        await assert.rejects(
          company.listPlanUsers(owner.id, {}),
          errorCode("ADMIN_REQUIRED"),
        );
      },
    );
    const personal = await upload(members[0]!.id);
    await t.test(
      "phone lookup reveals a minimal card and does not add the colleague",
      async () => {
        const person = await company.lookupColleague(
          owner.id,
          members[0]!.phone.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!),
        );
        assert.equal(person.id, members[0]!.id);
        assert.deepEqual(Object.keys(person).sort(), [
          "createdAt",
          "id",
          "name",
          "phone",
        ]);
        assert.equal(
          (await company.getCompanyDashboard(owner.id)).seats.total,
          0,
        );
        await assert.rejects(
          company.lookupColleague(members[0]!.id, owner.phone),
          errorCode("COMPANY_PLAN_REQUIRED"),
        );
        await assert.rejects(
          company.lookupColleague(owner.id, owner.phone),
          errorCode("COLLEAGUE_IS_OWNER"),
        );
      },
    );
    await t.test(
      "parallel additions reserve at most three seats including pending invitations",
      async () => {
        const outcomes = await Promise.allSettled(
          members
            .slice(0, 4)
            .map((user) => company.addColleague(owner.id, user.id, "invite")),
        );
        assert.equal(
          outcomes.filter((o) => o.status === "fulfilled").length,
          3,
        );
        const failed = outcomes.find(
          (o) => o.status === "rejected",
        ) as PromiseRejectedResult;
        assert.equal(failed.reason.code, "COMPANY_SEATS_FULL");
        const dashboard = await company.getCompanyDashboard(owner.id);
        assert.equal(dashboard.seats.total, 3);
        for (const invite of dashboard.invitations)
          await company.revokeCompanyInvitation(owner.id, invite.id);
        for (const member of dashboard.members.filter(
          (m) => m.role === "member",
        ))
          await company.removeCompanyMember(owner.id, member.id);
      },
    );
    await t.test(
      "only invitee acceptance grants membership and keeps personal history private",
      async () => {
        const invitation = await company.addColleague(owner.id, members[0]!.id);
        assert.equal(
          (await company.getBusinessContext(members[0]!.id)).company,
          null,
        );
        await assert.rejects(
          company.respondToInvitation(owner.id, invitation.id, "accept"),
          errorCode("INVITATION_NOT_FOUND"),
        );
        await company.respondToInvitation(
          members[0]!.id,
          invitation.id,
          "accept",
        );
        const context = await company.getBusinessContext(members[0]!.id);
        assert.equal(context.plan.code, "starter");
        assert.equal(context.effectivePlan.code, "advanced");
        assert.equal(
          (await company.getCompanyDashboard(owner.id)).usage.uploads,
          0,
        );
        assert.equal(
          (
            await database.uploadActivity.findUniqueOrThrow({
              where: { id: personal.id },
            })
          ).companyId,
          null,
        );
        await assert.rejects(
          company.getCompanyDashboard(members[0]!.id),
          errorCode("COMPANY_PLAN_REQUIRED"),
        );
        await assert.rejects(
          company.addColleague(otherOwner.id, members[0]!.id, "invite"),
          errorCode("COLLEAGUE_ALREADY_MEMBER"),
        );
        await assert.rejects(
          company.assignUserPlan(admin.id, members[0]!.id, "advanced"),
          errorCode("COLLEAGUE_ALREADY_MEMBER"),
        );
      },
    );
    await t.test(
      "company stats record new uploads and healing, survive deletion and stop after leaving",
      async () => {
        const record = await upload(members[0]!.id);
        await uploads.updateUploadHealingMetrics(record.id, "completed", 5);
        let dashboard = await company.getCompanyDashboard(owner.id);
        assert.deepEqual(dashboard.usage, {
          uploads: 1,
          bytes: 1234,
          identifiedIssues: 7,
          healedIssues: 5,
          storedFiles: 1,
        });
        assert.equal(
          await uploads.deleteUserUploadRecord(record.id, otherOwner.id),
          false,
        );
        assert.equal(
          await uploads.deleteUserUploadRecord(record.id, members[0]!.id),
          true,
        );
        await assert.rejects(
          company.removeCompanyMember(otherOwner.id, members[0]!.id),
          errorCode("MEMBER_NOT_FOUND"),
        );
        await company.removeCompanyMember(members[0]!.id, members[0]!.id);
        await upload(members[0]!.id);
        dashboard = await company.getCompanyDashboard(owner.id);
        assert.equal(dashboard.usage.uploads, 1);
        assert.equal(dashboard.usage.storedFiles, 0);
        const failed = await upload(owner.id);
        await uploads.deleteUploadRecord(failed.id);
        assert.equal(
          (await company.getCompanyDashboard(owner.id)).usage.uploads,
          1,
        );
      },
    );
    await t.test(
      "invitation ownership, decline, expiry and duplicate actions are enforced",
      async () => {
        const invite = await company.addColleague(
          owner.id,
          members[1]!.id,
          "invite",
        );
        assert.equal(
          (await company.getBusinessContext(members[1]!.id)).invitations[0]?.id,
          invite.id,
        );
        await assert.rejects(
          company.respondToInvitation(members[2]!.id, invite.id, "accept"),
          errorCode("INVITATION_NOT_FOUND"),
        );
        await company.respondToInvitation(members[1]!.id, invite.id, "decline");
        await assert.rejects(
          company.respondToInvitation(members[1]!.id, invite.id, "accept"),
          errorCode("INVITATION_NOT_PENDING"),
        );
        const expired = await company.addColleague(
          owner.id,
          members[1]!.id,
          "invite",
        );
        await database.companyInvitation.update({
          where: { id: expired.id },
          data: { expiresAt: new Date(0) },
        });
        await assert.rejects(
          company.respondToInvitation(members[1]!.id, expired.id, "accept"),
          errorCode("INVITATION_EXPIRED"),
        );
        assert.equal(
          (await company.getCompanyDashboard(owner.id)).seats.total,
          0,
        );
      },
    );
    await t.test(
      "simultaneous invitation acceptances cannot join two companies",
      async () => {
        const first = await company.addColleague(
          owner.id,
          members[2]!.id,
          "invite",
        );
        const second = await company.addColleague(
          otherOwner.id,
          members[2]!.id,
          "invite",
        );
        const results = await Promise.allSettled([
          company.respondToInvitation(members[2]!.id, first.id, "accept"),
          company.respondToInvitation(members[2]!.id, second.id, "accept"),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          await database.companyMember.count({
            where: { userId: members[2]!.id },
          }),
          1,
        );
        assert.equal(
          (await company.getBusinessContext(members[2]!.id)).invitations.length,
          0,
        );
      },
    );
    await t.test(
      "downgrade suspends company entitlement without losing team or historical stats",
      async () => {
        const membershipInvite = await company.addColleague(
          owner.id,
          members[3]!.id,
        );
        await company.respondToInvitation(
          members[3]!.id,
          membershipInvite.id,
          "accept",
        );
        const invite = await company.addColleague(
          owner.id,
          members[4]!.id,
          "invite",
        );
        const before = await company.getCompanyDashboard(owner.id);
        await company.assignUserPlan(admin.id, owner.id, "pro");
        assert.equal(
          (await company.getBusinessContext(members[3]!.id)).effectivePlan.code,
          "starter",
        );
        await assert.rejects(
          company.respondToInvitation(members[4]!.id, invite.id, "accept"),
          errorCode("COMPANY_PLAN_REQUIRED"),
        );
        await assert.rejects(
          company.addColleague(owner.id, members[5]!.id, "invite"),
          errorCode("COMPANY_PLAN_REQUIRED"),
        );
        await upload(members[3]!.id);
        assert.deepEqual(
          (await company.getCompanyDashboard(owner.id)).usage,
          before.usage,
        );
        await company.assignUserPlan(admin.id, owner.id, "advanced");
        assert.equal(
          (await company.getBusinessContext(members[3]!.id)).effectivePlan.code,
          "advanced",
        );
        assert.equal(
          (await company.getCompanyDashboard(owner.id)).members.length,
          before.members.length,
        );
      },
    );
    await t.test(
      "HTTP routes enforce authentication, fresh admin roles, validation and public plans",
      async () => {
        const app = express();
        app.use(express.json());
        app.use("/business", router);
        app.use(((err, _req, res, _next) =>
          res
            .status(err.statusCode ?? 500)
            .json({ code: err.code })) as ErrorRequestHandler);
        const server = app.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          const url = `http://127.0.0.1:${address.port}/business`;
          const headers = {
            Authorization: `Bearer ${createAccessToken({ id: owner.id, roles: ["admin"] })}`,
            "Content-Type": "application/json",
          };
          const direct = await fetch(`${url}/company/members`, {
            method: "POST",
            headers,
            body: JSON.stringify({ userId: members[5]!.id, mode: "direct" }),
          });
          assert.equal(direct.status, 400);
          assert.equal((await direct.json()).code, "INVALID_MEMBER_MODE");
          assert.equal(
            await database.companyMember.count({
              where: { userId: members[5]!.id },
            }),
            0,
          );
          assert.equal(
            await database.companyInvitation.count({
              where: { userId: members[5]!.id },
            }),
            0,
          );
          assert.equal((await fetch(`${url}/plans`)).status, 200);
          assert.equal((await fetch(`${url}/me`)).status, 401);
          assert.equal((await fetch(`${url}/me`, { headers })).status, 200);
          assert.equal(
            (await fetch(`${url}/admin/users`, { headers })).status,
            403,
          );
          assert.equal(
            (
              await fetch(`${url}/company/members`, {
                method: "POST",
                headers,
                body: JSON.stringify({ userId: "invalid", mode: "direct" }),
              })
            ).status,
            400,
          );
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          );
        }
      },
    );
  },
);
