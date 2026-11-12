import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

const integration = process.env.CADASTRAL_INTEGRATION === "1" ? test : test.skip;
integration("cadastral drawings are personal, image-scoped, company-gated and revision-checked", async (t) => {
  const { default: express } = await import("express");
  const { router } = await import("../routes/business.route");
  const { globalErrorHandler } = await import("../middlewares/errorHandler");
  const { database } = await import("./database.service");
  const { createAccessToken } = await import("./token.service");
  const app = express();
  app.use(express.json(), router, globalErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  const userIds: string[] = [];
  const companyIds: string[] = [];
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.spatialImage.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.company.deleteMany({ where: { id: { in: companyIds } } });
    await database.user.deleteMany({ where: { id: { in: userIds } } });
    await database.$disconnect();
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/company/spatial-images`;
  const newUser = async (planCode: "starter" | "advanced") => {
    const user = await database.user.create({ data: {
      name: "Cadastral test", phone: `t${randomUUID().slice(0, 15)}`, passwordHash: "unused", planCode,
    } });
    userIds.push(user.id);
    return user.id;
  };
  const ownerId = await newUser("advanced");
  const memberId = await newUser("starter");
  const outsider = await newUser("advanced");
  for (const userId of [ownerId, outsider]) {
    const company = await database.company.create({ data: { ownerId: userId, name: "Cadastral test" } });
    companyIds.push(company.id);
  }
  const companyId = companyIds[0]!;
  await database.companyMember.create({ data: { companyId, userId: memberId } });
  const createImage = (status: "ready" | "processing") => database.spatialImage.create({ data: {
    companyId, uploaderId: ownerId, name: "test.tif", size: 1n, expiresAt: new Date(), status,
  } });
  const image = await createImage("ready");
  const processing = await createImage("processing");

  const request = (userId: string, drawing?: object, imageId = image.id) => fetch(`${base}/${imageId}/drawing`, {
    method: drawing ? "PUT" : "GET",
    headers: {
      Authorization: `Bearer ${createAccessToken({ id: userId, roles: ["user"] })}`,
      ...(drawing ? { "Content-Type": "application/json" } : {}),
    },
    ...(drawing ? { body: JSON.stringify(drawing) } : {}),
  });
  const features = [{ id: "parcel", kind: "parcel", vertices: [[51, 35], [52, 35], [52, 36], [51, 36]] }];
  assert.equal((await request(outsider)).status, 404);
  assert.equal((await request(memberId, undefined, processing.id)).status, 404);
  assert.deepEqual((await (await request(memberId)).json()).data, { revision: 0, features: [] });

  const requests = await Promise.all([
    request(memberId, { revision: 0, features }),
    request(memberId, { revision: 0, features }),
  ]);
  assert.deepEqual(requests.map(({ status }) => status).sort(), [200, 409]);
  assert.deepEqual((await (await request(memberId)).json()).data, { revision: 1, features });
  assert.deepEqual((await (await request(ownerId)).json()).data, { revision: 0, features: [] });
  assert.equal((await request(memberId, { revision: 1, features: [] })).status, 200);
  assert.deepEqual((await (await request(memberId)).json()).data, { revision: 2, features: [] });

  await database.companyMember.delete({ where: { userId: memberId } });
  assert.equal((await request(memberId)).status, 403);
  assert.equal((await request(memberId, { revision: 2, features })).status, 403);
  await database.spatialImage.delete({ where: { id: image.id } });
  assert.equal(await database.cadastralDrawing.count({ where: { imageId: image.id } }), 0);
});
