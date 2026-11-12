import type { Prisma } from "@prisma/client";
import kinks from "@turf/kinks";
import { polygon } from "@turf/helpers";
import { AppError } from "../middlewares/errorHandler";
import { lockCompany } from "./company.service";
import { database } from "./database.service";
import { activeCompany } from "./spatial-image.service";

type Vertex = [number, number];
type Shape = { id: string; kind: "line" | "parcel"; vertices: Vertex[] };

const invalid = () => new AppError(400, "هندسهٔ ترسیم معتبر نیست.", "INVALID_DRAWING");
const conflict = () => new AppError(409, "این ترسیم در پنجره‌ای دیگر تغییر کرده است.", "DRAWING_CONFLICT");

export const parseDrawing = (body: unknown) => {
  const { revision, features } = (body ?? {}) as { revision?: unknown; features?: unknown };
  if (typeof revision !== "number" || !Number.isInteger(revision) ||
      revision < 0 || revision >= 2_147_483_647 || !Array.isArray(features) || features.length > 500)
    throw invalid();
  const ids = new Set<string>();
  let total = 0;
  const shapes: Shape[] = features.map((value: unknown) => {
    const { id, kind, vertices } = (value ?? {}) as Partial<Shape>;
    if (typeof id !== "string" || !/^[a-z\d-]{1,64}$/i.test(id) || ids.has(id) ||
        (kind !== "line" && kind !== "parcel") || !Array.isArray(vertices) ||
        vertices.length < (kind === "line" ? 2 : 3) || vertices.length > 1000)
      throw invalid();
    ids.add(id);
    total += vertices.length;
    if (total > 8000) throw invalid();
    const seen = new Set<string>();
    const points: Vertex[] = vertices.map((point: unknown) => {
      if (!Array.isArray(point) || point.length !== 2 ||
          !point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)) ||
          Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.051129)
        throw invalid();
      const key = point.join(",");
      if (seen.has(key)) throw invalid();
      seen.add(key);
      return [point[0], point[1]];
    });
    if (kind === "parcel") {
      const first = points[0]!;
      const ring = [...points, first];
      const signed = points.reduce((sum, [x, y], index) => {
        const [nextX, nextY] = ring[index + 1]!;
        return sum + (x - first[0]) * (nextY - first[1]) - (y - first[1]) * (nextX - first[0]);
      }, 0);
      if (signed === 0 || kinks(polygon([ring])).features.length) throw invalid();
    }
    return { id, kind, vertices: points };
  });
  return { revision, features: shapes };
};

const requireReadyImage = async (tx: Prisma.TransactionClient, imageId: string, companyId: string) => {
  const image = await tx.spatialImage.findFirst({ where: { id: imageId, companyId, status: "ready" }, select: { id: true } });
  if (!image) throw new AppError(404, "تصویر آمادهٔ ترسیم پیدا نشد.", "DRAWING_IMAGE_NOT_FOUND");
};

export const getCadastralDrawing = async (userId: string, imageId: string) => {
  const { id: companyId } = await activeCompany(database, userId);
  await requireReadyImage(database, imageId, companyId);
  const drawing = await database.cadastralDrawing.findUnique({
    where: { imageId_userId: { imageId, userId } },
    select: { revision: true, features: true },
  });
  return drawing ?? { revision: 0, features: [] };
};

export const saveCadastralDrawing = async (userId: string, imageId: string, body: unknown) => {
  const company = await activeCompany(database, userId);
  const { revision, features } = parseDrawing(body);
  return database.$transaction(async (tx) => {
    await lockCompany(tx, company.id);
    if ((await activeCompany(tx, userId)).id !== company.id)
      throw new AppError(403, "عضویت شرکت تغییر کرده است.", "COMPANY_PLAN_REQUIRED");
    // Keep the ready image available until the drawing has been saved.
    await tx.$queryRaw`SELECT id FROM spatial_images WHERE id = ${imageId}::uuid AND company_id = ${company.id}::uuid FOR SHARE`;
    await requireReadyImage(tx, imageId, company.id);
    if (revision === 0) {
      const created = await tx.cadastralDrawing.createMany({ data: { imageId, userId, features }, skipDuplicates: true });
      if (!created.count) throw conflict();
    } else {
      const updated = await tx.cadastralDrawing.updateMany({
        where: { imageId, userId, revision }, data: { features, revision: { increment: 1 } },
      });
      if (!updated.count) throw conflict();
    }
    return { revision: revision + 1, features };
  });
};
