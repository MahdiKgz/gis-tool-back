import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { database } from "../services/database.service";
import { objectStorageEnabled, objectKey, objectReference, signedUpload, storedStat, materializeStoredFile } from "../services/object-storage.service";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import { AppError } from "../middlewares/errorHandler";
import { uploadGeoJson } from "./upload.controller";

export const createStorageUpload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!objectStorageEnabled()) throw new AppError(503, 'Direct storage upload is not configured', 'STORAGE_UNAVAILABLE');
    const userId = getAuthenticatedUserId(req);
    const { fileName, size } = req.body ?? {};
    if (typeof fileName !== 'string' || fileName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(fileName) || !/\.(geojson|json|zip|shp|kml|kmz|dwg|dgn)$/i.test(fileName))
      throw new AppError(400, 'Provide a supported GIS filename without a path', 'INVALID_FILE_NAME');
    const id = randomUUID();
    const key = `temporary/incoming/${objectKey(userId, id, 'incoming', fileName)}`;
    const post = await signedUpload(key, size);
    const expiresAt = new Date(Date.now() + 900000);
    await database.storageUpload.create({ data: { id, userId, key, originalName: fileName, size, expiresAt } });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: { uploadId: id, method: 'POST', ...post, expiresAt,
      completePath: `/api/upload/${id}/complete` } });
  } catch (error) { next(error); }
};

export const completeStorageUpload = async (req: Request, res: Response, next: NextFunction) => {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const userId = getAuthenticatedUserId(req);
    const id = req.params.uploadId;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new AppError(404, 'Upload not found', 'UPLOAD_NOT_FOUND');
    const ticket = await database.storageUpload.findFirst({ where: { id, userId } });
    if (!ticket) throw new AppError(404, 'Upload not found', 'UPLOAD_NOT_FOUND');
    if (ticket.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'Upload expired', 'UPLOAD_EXPIRED');
    const reference = objectReference(ticket.key);
    const info = await storedStat(reference);
    if (info.size !== ticket.size) throw new AppError(422, 'Uploaded size does not match the authorized upload', 'UPLOAD_SIZE_MISMATCH');
    const claimed = await database.storageUpload.updateMany({ where: { id, userId, claimedAt: null, expiresAt: { gt: new Date() } }, data: { claimedAt: new Date() } });
    if (!claimed.count) throw new AppError(409, 'Upload already submitted', 'UPLOAD_ALREADY_SUBMITTED');
    // Read a private snapshot: replaying the presigned POST can only replace the staging object.
    const local = await materializeStoredFile(reference, ticket.originalName);
    cleanup = local.cleanup;
    const actual = await storedStat(local.filePath);
    if (actual.size !== ticket.size) throw new AppError(422, 'Uploaded size changed', 'UPLOAD_SIZE_MISMATCH');
    req.file = { path: local.filePath, originalname: ticket.originalName, filename: `${id}${path.extname(ticket.originalName).toLowerCase()}`,
      size: actual.size, mimetype: 'application/octet-stream', fieldname: 'file', encoding: '7bit', destination: path.dirname(local.filePath) } as Express.Multer.File;
    await uploadGeoJson(req, res, next);
  } catch (error) { next(error); }
  finally { await cleanup?.(); }
};
