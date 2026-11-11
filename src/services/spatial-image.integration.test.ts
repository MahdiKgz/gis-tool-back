import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const integration = process.env.SPATIAL_IMAGE_INTEGRATION === "1" ? test : test.skip;
integration("company image API reserves a shared quota and serves private raster tiles through MinIO ranges", { timeout: 90000 }, async (t) => {
  const { default: express } = await import("express");
  const { router } = await import("../routes/business.route");
  const { globalErrorHandler } = await import("../middlewares/errorHandler");
  const { database } = await import("./database.service");
  const { createAccessToken } = await import("./token.service");
  const storage = await import("./object-storage.service");
  const imagery = await import("./spatial-image.service");
  const { startSpatialImageWorker } = await import("./spatial-image-queue.service");
  const { gisQueue, redisConnection } = await import("./queue.service");
  const workspace = await fs.mkdtemp(path.join(process.env.SPATIAL_IMAGE_TMP_DIR || os.tmpdir(), "snapgis-raster-test-"));
  const app = express();
  app.use(express.json(), router, globalErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  const worker = startSpatialImageWorker();
  const users: string[] = [];
  let companyId: string | undefined;
  t.after(async () => {
    await worker.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (companyId) {
      const images = await database.spatialImage.findMany({ where: { companyId } });
      await Promise.all(images.flatMap((image) => [
        storage.removeStoredFile(imagery.imageOriginal(image)),
        storage.removeStoredFile(imagery.imageArchive(image)),
        storage.removeStoredFile(storage.objectReference(imagery.imageStagingKey(image))),
      ]));
      await database.spatialImage.deleteMany({ where: { companyId } });
      await database.company.delete({ where: { id: companyId } });
    }
    await database.user.deleteMany({ where: { id: { in: users } } });
    await fs.rm(workspace, { recursive: true, force: true });
    await database.$disconnect();
    await gisQueue.close();
    await redisConnection.quit();
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/company/spatial-images`;
  const createUser = async (planCode: "advanced" | "starter" = "starter") => {
    const user = await database.user.create({ data: {
      name: "Imagery test", phone: `t${randomUUID().slice(0, 15)}`, passwordHash: "unused", planCode,
    } });
    users.push(user.id);
    return user.id;
  };
  const ownerId = await createUser("advanced");
  const memberId = await createUser();
  const strangerId = await createUser();
  const company = await database.company.create({ data: { ownerId, name: "Imagery test" } });
  companyId = company.id;
  await database.companyMember.create({ data: { companyId, userId: memberId } });

  const request = (userId: string, suffix = "", method = "GET", data?: unknown) => fetch(endpoint + suffix, {
    method,
    headers: {
      Authorization: `Bearer ${createAccessToken({ id: userId, roles: ["user"] })}`,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await request(strangerId)).status, 403);

  await fs.writeFile(path.join(workspace, "fixture.asc"), [
    "ncols 4", "nrows 4", "xllcorner 51.39", "yllcorner 35.68", "cellsize 0.01",
    "1 2 3 4", "5 6 7 8", "9 10 11 12", "13 14 15 16",
  ].join("\n"));
  execFileSync(process.env.GDAL_TRANSLATE_BIN || "gdal_translate", [
    "-of", "GTiff", "-a_srs", "EPSG:4326", "-outsize", "256", "256", "fixture.asc", "fixture.tif",
  ], { cwd: workspace });
  const bytes = await fs.readFile(path.join(workspace, "fixture.tif"));
  const responses = await Promise.all([ownerId, memberId, ownerId, memberId].map(
    (userId) => request(userId, "/presign", "POST", { fileName: "fixture.tif", size: bytes.length }),
  ));
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 201, 201, 409]);
  const { data: { images } } = await (await request(memberId)).json();
  assert.equal(images.length, 3);

  const winningIndex = responses.findIndex(({ status }) => status === 201);
  const uploader = winningIndex % 2 ? memberId : ownerId;
  const otherMember = uploader === memberId ? ownerId : memberId;
  const { data: ticket } = await responses[winningIndex]!.json();
  const id = `/${ticket.id}`;
  assert.equal((await request(otherMember, id + "/complete", "POST")).status, 404);
  assert.equal((await request(uploader, id + "/complete", "POST")).status, 422);

  const post = (payload: Uint8Array<ArrayBuffer>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) form.append(name, String(value));
    form.append("file", new Blob([payload], { type: "image/tiff" }), "fixture.tif");
    return fetch(ticket.url, { method: "POST", body: form });
  };
  assert.ok(!(await post(new Uint8Array(bytes.length + 1))).ok);
  assert.ok((await post(Uint8Array.from(bytes))).ok);
  assert.equal((await request(uploader, id + "/complete", "POST")).status, 202);
  assert.equal((await request(uploader, id + "/complete", "POST")).status, 202);

  await t.waitFor(async () => {
    const image = await database.spatialImage.findUniqueOrThrow({ where: { id: ticket.id } });
    assert.equal(image.status, "ready");
  }, { timeout: 45000, interval: 500 });

  const preview = await request(otherMember, id + "/preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const { data: { url } } = await preview.json();
  const unsigned = new URL(url);
  unsigned.search = "";
  assert.equal((await fetch(unsigned)).status, 403);
  const range = await fetch(url, { headers: { Range: "bytes=0-126", Origin: "http://localhost:5173" } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get("content-range") ?? "", /^bytes 0-126\//);
  assert.equal((await range.text()).slice(0, 7), "PMTiles");
  const image = await database.spatialImage.findUniqueOrThrow({ where: { id: ticket.id } });
  assert.equal((await storage.storedObjectStat(imagery.imageOriginal(image))).size, bytes.length);

  await database.user.update({ where: { id: ownerId }, data: { planCode: "pro" } });
  assert.equal((await request(memberId, id + "/preview")).status, 403);
  await database.user.update({ where: { id: ownerId }, data: { planCode: "advanced" } });
  assert.equal((await request(ownerId, id, "DELETE")).status, 200);
  assert.equal((await request(memberId, id + "/preview")).status, 404);
  assert.equal((await fetch(url)).status, 404);
});
