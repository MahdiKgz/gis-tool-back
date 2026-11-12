import { randomUUID } from "node:crypto";
import type { Prisma, SpatialImage } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";
import { lockCompany } from "./company.service";
import { database } from "./database.service";
import {
  objectReference, objectStorageEnabled, removeStoredFile, signedDownload,
  signedExactUpload, storedObjectStat,
} from "./object-storage.service";

export const SPATIAL_IMAGE_LIMIT = 3;
export const MAX_SPATIAL_IMAGE_BYTES = 5 * 1024 ** 3;
const UPLOAD_SECONDS = 4 * 60 * 60;

export const parseSpatialImageUpload = (body: unknown) => {
  const { fileName, size } = (body ?? {}) as { fileName?: unknown; size?: unknown };
  if (typeof fileName !== "string" || fileName.length > 255 ||
      /[\\/\x00-\x1f\x7f]/.test(fileName) || !/\.tiff?$/i.test(fileName))
    throw new AppError(400, "فایل باید با پسوند TIFF یا TIF باشد.", "INVALID_IMAGE_NAME");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_SPATIAL_IMAGE_BYTES)
    throw new AppError(413, "حجم هر تصویر باید حداکثر ۵ گیگابایت باشد.", "IMAGE_TOO_LARGE");
  return { fileName, size };
};

export const activeCompany = async (client: Prisma.TransactionClient, userId: string) => {
  const company = await client.company.findFirst({
    where: {
      owner: { planCode: "advanced" },
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true, ownerId: true },
  });
  if (!company) throw new AppError(403, "تصاویر مکانی به پلن شرکتی فعال نیاز دارد.", "COMPANY_PLAN_REQUIRED");
  return company;
};

const inUse = (now: Date): Prisma.SpatialImageWhereInput => ({
  OR: [{ status: { not: "uploading" } }, { expiresAt: { gt: now } }],
});

const summarize = (image: SpatialImage, userId: string, ownerId: string) => ({
  id: image.id,
  name: image.name,
  size: Number(image.size),
  status: image.status,
  errorCode: image.errorCode,
  canComplete: image.status === "uploading" && image.uploaderId === userId,
  canDelete: image.status !== "processing" && (image.uploaderId === userId || ownerId === userId),
});

const imageKey = (image: Pick<SpatialImage, "id" | "companyId">) => `spatial-images/${image.companyId}/${image.id}`;
export const imageStagingKey = (image: Pick<SpatialImage, "id" | "companyId">) =>
  `temporary/${imageKey(image)}/upload.tiff`;
export const imageOriginal = (image: SpatialImage) => objectReference(`${imageKey(image)}/original.tiff`);
export const imageArchive = (image: SpatialImage) => objectReference(`${imageKey(image)}/map.pmtiles`);

const getImage = async (userId: string, id: string) => {
  const company = await activeCompany(database, userId);
  const image = await database.spatialImage.findFirst({ where: { id, companyId: company.id } });
  if (!image) throw new AppError(404, "تصویر پیدا نشد.", "IMAGE_NOT_FOUND");
  return { company, image };
};

export const listSpatialImages = async (userId: string) => {
  const company = await activeCompany(database, userId);
  const images = await database.spatialImage.findMany({
    where: { companyId: company.id, ...inUse(new Date()) },
    orderBy: { createdAt: "desc" },
  });
  return {
    images: images.map((image) => summarize(image, userId, company.ownerId)),
    limit: SPATIAL_IMAGE_LIMIT,
    maxBytes: MAX_SPATIAL_IMAGE_BYTES,
  };
};

export const reserveSpatialImage = async (userId: string, body: unknown) => {
  const company = await activeCompany(database, userId);
  if (!objectStorageEnabled())
    throw new AppError(503, "فضای ذخیره‌سازی تصاویر در دسترس نیست.", "STORAGE_UNAVAILABLE");
  const { fileName, size } = parseSpatialImageUpload(body);
  const id = randomUUID();
  return database.$transaction(async (tx) => {
    await lockCompany(tx, company.id);
    if ((await activeCompany(tx, userId)).id !== company.id)
      throw new AppError(403, "عضویت شرکت تغییر کرده است.", "COMPANY_PLAN_REQUIRED");
    const now = new Date();
    const used = await tx.spatialImage.count({ where: { companyId: company.id, ...inUse(now) } });
    if (used >= SPATIAL_IMAGE_LIMIT)
      throw new AppError(409, "سهمیهٔ سه تصویر شرکت پر شده است.", "SPATIAL_IMAGE_LIMIT");
    const expiresAt = new Date(now.getTime() + UPLOAD_SECONDS * 1000);
    const post = await signedExactUpload(imageStagingKey({ companyId: company.id, id }), size, UPLOAD_SECONDS, "image/tiff");
    await tx.spatialImage.create({
      data: { id, companyId: company.id, uploaderId: userId, name: fileName, size: BigInt(size), expiresAt },
    });
    return { id, ...post, expiresAt };
  });
};

export const completeSpatialImage = async (userId: string, id: string) => {
  const { image, company } = await getImage(userId, id);
  if (image.uploaderId !== userId)
    throw new AppError(404, "تصویر پیدا نشد.", "IMAGE_NOT_FOUND");
  if (image.status !== "uploading") {
    if (image.status === "deleting") throw new AppError(409, "تصویر در حال حذف است.", "IMAGE_DELETING");
    return summarize(image, userId, company.ownerId);
  }
  if (image.expiresAt <= new Date())
    throw new AppError(410, "زمان بارگذاری تصویر تمام شده است.", "UPLOAD_EXPIRED");
  const info = await storedObjectStat(objectReference(imageStagingKey(image))).catch((error) => {
    if (error.code === "ENOENT")
      throw new AppError(422, "بارگذاری فایل هنوز کامل نشده است.", "IMAGE_UPLOAD_MISSING");
    throw error;
  });
  const { etag } = info;
  if (info.size !== Number(image.size) || !etag)
    throw new AppError(422, "اندازهٔ فایل بارگذاری‌شده معتبر نیست.", "UPLOAD_SIZE_MISMATCH");
  return database.$transaction(async (tx) => {
    await lockCompany(tx, company.id);
    if ((await activeCompany(tx, userId)).id !== company.id)
      throw new AppError(403, "عضویت شرکت تغییر کرده است.", "COMPANY_PLAN_REQUIRED");
    const claimed = await tx.spatialImage.updateMany({
      where: { id, status: "uploading", expiresAt: { gt: new Date() } },
      data: { status: "processing", uploadETag: etag },
    });
    const current = await tx.spatialImage.findUnique({ where: { id } });
    if (!current || current.status === "deleting" || (!claimed.count && current.status === "uploading"))
      throw new AppError(409, "بارگذاری تصویر دیگر در دسترس نیست.", "IMAGE_UPLOAD_UNAVAILABLE");
    return summarize(current, userId, company.ownerId);
  });
};

export const spatialImagePreview = async (userId: string, id: string) => {
  const { image } = await getImage(userId, id);
  if (image.status !== "ready")
    throw new AppError(409, "تصویر هنوز برای نمایش آماده نیست.", "IMAGE_NOT_READY");
  const expiresAt = new Date(Date.now() + 900_000);
  return { url: await signedDownload(imageArchive(image)), expiresAt };
};

export const deleteSpatialImage = async (userId: string, id: string) => {
  const { image, company } = await getImage(userId, id);
  if (userId !== image.uploaderId && userId !== company.ownerId)
    throw new AppError(403, "حذف تصویر فقط برای بارگذار یا مدیر شرکت مجاز است.", "IMAGE_DELETE_FORBIDDEN");
  const marked = await database.spatialImage.updateMany({
    where: { id, status: { not: "processing" } }, data: { status: "deleting" },
  });
  if (!marked.count) throw new AppError(409, "تصویر در حال آماده‌سازی است.", "IMAGE_PROCESSING");
  await Promise.all([
    removeStoredFile(objectReference(imageStagingKey(image))),
    removeStoredFile(imageOriginal(image)),
    removeStoredFile(imageArchive(image)),
  ]);
  await database.spatialImage.deleteMany({ where: { id, status: "deleting" } });
  return { id };
};
