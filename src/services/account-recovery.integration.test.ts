import assert from "node:assert/strict";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { globalErrorHandler } from "../middlewares/errorHandler";

test(
  "verifies account email and resets the password through one-time SMTP links",
  {
    skip: process.env.AUTH_RECOVERY_INTEGRATION !== "1",
    timeout: 15_000,
  },
  async (t) => {
    const messages: string[] = [];
    const smtp = createServer((socket) => {
      let data: string[] | null = null;
      socket.write("220 localhost test relay\r\n");
      createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
        if (data && line !== ".") {
          data.push(line);
        } else if (data) {
          messages.push(data.join("\r\n"));
          data = null;
          socket.write("250 Accepted\r\n");
        } else if (line === "DATA") {
          data = [];
          socket.write("354 End data with a dot\r\n");
        } else if (line === "QUIT") {
          socket.end("221 Bye\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      });
    }).listen(0, "127.0.0.1");
    await once(smtp, "listening");
    t.after(() => smtp.close());
    const smtpAddress = smtp.address();
    assert.ok(smtpAddress && typeof smtpAddress === "object");

    process.env.SMTP_URL = `smtp://127.0.0.1:${smtpAddress.port}`;
    process.env.SMTP_FROM = "SnapGIS <no-reply@example.com>";
    process.env.APP_PUBLIC_ORIGIN = "https://snapgis.example";
    process.env.JWT_ACCESS_SECRET ||= "test-only-account-recovery-signing-secret";

    const { router } = await import("../routes/auth.route");
    const { authRedis, connectAuthRedis } = await import("./auth-redis.service");
    const { database } = await import("./database.service");
    await connectAuthRedis();
    const phonePrefix = randomInt(10000000, 100000000);
    const phones = [`09${phonePrefix}1`, `09${phonePrefix}2`] as const;
    const clientIp = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
    t.after(async () => {
      await database.user.deleteMany({ where: { phone: { in: [...phones] } } });
      await database.$disconnect();
      authRedis.disconnect();
    });

    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json(), cookieParser());
    app.use("/api/auth", router);
    app.use(globalErrorHandler);
    const api = app.listen(0, "127.0.0.1");
    await once(api, "listening");
    t.after(() => api.close());
    const apiAddress = api.address();
    assert.ok(apiAddress && typeof apiAddress === "object");

    const request = (path: string, body: object, headers?: Record<string, string>) =>
      fetch(`http://127.0.0.1:${apiAddress.port}/api/auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": clientIp, ...headers },
        body: JSON.stringify(body),
      });

    const readLink = (index: number) => {
      const message = messages[index];
      assert.ok(message);
      const [headers, body] = message.split("\r\n\r\n");
      assert.ok(headers && body);
      const decoded = /transfer-encoding: base64/i.test(headers)
        ? Buffer.from(body, "base64").toString()
        : body.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
      const match = decoded.match(/https:\/\/snapgis\.example\/[^\s]+/);
      assert.ok(match);
      const url = new URL(match[0]);
      return { path: url.pathname, token: new URLSearchParams(url.hash.slice(1)).get("token") };
    };

    const password = "previous-password";
    const phone = phones[0];
    const first = await request("/register", { name: "Recovery Test", phone, password });
    assert.equal(first.status, 201);
    const cookie = first.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const { data: firstAccount } = await first.json();
    const owner = { Authorization: `Bearer ${firstAccount.accessToken}` };

    const second = await request("/register", { name: "Other Test", phone: phones[1], password });
    assert.equal(second.status, 201);
    const { data: secondAccount } = await second.json();
    const other = { Authorization: `Bearer ${secondAccount.accessToken}` };

    const email = `recovery-${phone}@example.com`;
    assert.equal((await request("/email", { email, password: "wrong-password" }, owner)).status, 403);
    assert.equal((await request("/email", { email, password }, owner)).status, 200);
    const verification = readLink(0);
    assert.equal(verification.path, "/dashboard/security");

    const pending = await request("/forgot-password", { email });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { success: true });
    await setTimeout(100);
    assert.equal(messages.length, 1);
    assert.equal((await request("/email/verify", verification, other)).status, 400);
    assert.equal((await request("/email/verify", verification, owner)).status, 200);
    assert.equal((await request("/email/verify", verification, owner)).status, 400);

    const unknown = await request("/forgot-password", { email: `unknown-${phone}@example.com` });
    assert.equal(unknown.status, 202);
    assert.deepEqual(await unknown.json(), { success: true });
    assert.equal((await request("/forgot-password", { email: email.toUpperCase() })).status, 202);
    await t.waitFor(() => assert.equal(messages.length, 2), { timeout: 3000 });
    const reset = readLink(1);
    assert.equal(reset.path, "/auth/reset");
    assert.ok(reset.token);
    assert.equal((await request("/email/verify", reset, owner)).status, 400);

    await database.user.update({ where: { phone }, data: { resetTokenExpires: new Date(0) } });
    const newPassword = "replacement-password";
    assert.equal(
      (await request("/reset-password", { token: reset.token, password: newPassword })).status,
      400,
    );
    assert.equal((await request("/forgot-password", { email })).status, 202);
    await t.waitFor(() => assert.equal(messages.length, 3), { timeout: 3000 });

    const active = readLink(2);
    const attempts = await Promise.all([
      request("/reset-password", { token: active.token, password: newPassword }),
      request("/reset-password", { token: active.token, password: newPassword }),
    ]);
    assert.deepEqual(attempts.map((response) => response.status).sort(), [204, 400]);
    assert.equal((await request("/refresh", {}, { Cookie: cookie })).status, 401);
    assert.equal((await request("/login", { phone, password })).status, 401);
    assert.equal((await request("/login", { phone, password: newPassword })).status, 200);
    assert.equal(messages.length, 3);
  },
);
