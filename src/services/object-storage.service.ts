import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../middlewares/errorHandler";

export const objectStorageEnabled = () => process.env.STORAGE_DRIVER === "s3";
export const isObjectReference = (value: string) => value.startsWith("s3://");
export const storageConfig = () => {
  const endpoint = process.env.S3_ENDPOINT;
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || endpoint;
  const accessKeyId = process.env.MINIO_APP_USER;
  const secretAccessKey = process.env.MINIO_APP_SECRET;
  if (!endpoint || !publicEndpoint || !accessKeyId || !secretAccessKey)
    throw new Error("Configure S3_ENDPOINT, MINIO_APP_USER and MINIO_APP_SECRET");
  for (const address of [endpoint, publicEndpoint]) {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error("S3 endpoints must be HTTP(S) origins without a path or credentials");
    if (process.env.NODE_ENV === 'production' && address === publicEndpoint && url.protocol !== 'https:')
      throw new Error("S3_PUBLIC_ENDPOINT requires HTTPS in production");
  }
  if (accessKeyId === process.env.MINIO_ROOT_USER)
    throw new Error("Application storage credentials must not use the MinIO root account");
  return { endpoint, publicEndpoint, bucket: process.env.S3_BUCKET || 'snapgis-files',
    region: process.env.S3_REGION || 'us-east-1', credentials: { accessKeyId, secretAccessKey } };
};
let clients: { signature: string; internal: S3Client; public: S3Client } | undefined;
const client = (publicAccess = false) => {
  const config = storageConfig();
  const signature = JSON.stringify(config);
  if (!clients || clients.signature !== signature) {
    clients?.internal.destroy(); clients?.public.destroy();
    const options = { region: config.region, credentials: config.credentials, forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const, responseChecksumValidation: 'WHEN_REQUIRED' as const,
      maxAttempts: 3, requestHandler: { connectionTimeout: 5000, requestTimeout: 120000 } };
    clients = { signature, internal: new S3Client({ ...options, endpoint: config.endpoint }),
      public: new S3Client({ ...options, endpoint: config.publicEndpoint }) };
  }
  return publicAccess ? clients.public : clients.internal;
};
export const objectKey = (ownerId: string, jobId: string, kind: 'original' | 'normalized' | 'healed' | 'conversion' | 'incoming', fileName: string) => {
  if (![ownerId, jobId].every(value => /^[a-zA-Z0-9-]+$/.test(value))) throw new Error('Invalid storage namespace');
  const name = path.basename(fileName.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_');
  if (!name || name === '.' || name === '..') throw new Error('Invalid object filename');
  return `${ownerId}/${jobId}/${kind}/${name}`;
};
export const objectReference = (key: string) => `s3://${storageConfig().bucket}/${key}`;
export const objectLocation = (reference: string) => {
  const prefix = `s3://${storageConfig().bucket}/`;
  if (!reference.startsWith(prefix)) throw new Error('Unmanaged object reference');
  const Key = reference.slice(prefix.length);
  if (!Key || Key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid object key');
  return { Bucket: storageConfig().bucket, Key };
};
export const objectMissing = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
export const putStoredFile = async (key: string, file: string, contentType = 'application/octet-stream') => {
  const reference = objectReference(key);
  const size = (await fs.stat(file)).size;
  const body = createReadStream(file);
  try { await client().send(new PutObjectCommand({ ...objectLocation(reference), Body: body,
    ContentLength: size, ContentType: contentType })); }
  finally { body.destroy(); }
  return reference;
};
export const storedStat = async (reference: string) => {
  if (!isObjectReference(reference)) return fs.stat(reference);
  try {
    const info = await client().send(new HeadObjectCommand(objectLocation(reference)));
    return { size: info.ContentLength ?? 0, isFile: () => true };
  } catch (error) {
    if (objectMissing(error)) throw Object.assign(new Error('Stored file not found'), { code: 'ENOENT' });
    throw error;
  }
};
export const removeStoredFile = async (reference: string) => {
  if (!isObjectReference(reference)) { await fs.rm(reference, { force: true }); return; }
  await client().send(new DeleteObjectCommand(objectLocation(reference)));
};
export const copyStoredFile = async (reference: string, destination: string, maxBytes = 500 * 1024 * 1024) => {
  if (!isObjectReference(reference)) { await fs.copyFile(reference, destination); return; }
  const response = await client().send(new GetObjectCommand(objectLocation(reference)));
  const body = response.Body as Readable;
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maxBytes ? new AppError(413, 'Stored file exceeds processing capacity', 'FILE_TOO_LARGE') : null, chunk);
  }});
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let created = false;
  output.once('open', () => { created = true; });
  try { await pipeline(body, limit, output); }
  catch (error) { body?.destroy(); if (created) await fs.rm(destination, { force: true }); throw error; }
};
export const materializeStoredFile = async (reference: string, name: string) => {
  if (!isObjectReference(reference)) return { filePath: reference, cleanup: async () => {} };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapgis-storage-'));
  const filePath = path.join(directory, path.basename(name));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try { await copyStoredFile(reference, filePath); return { filePath, cleanup }; }
  catch (error) { await cleanup(); throw error; }
};
export const signedDownload = async (reference: string, name?: string) => getSignedUrl(client(true), new GetObjectCommand({
  ...objectLocation(reference), ...(name ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(name))}` } : {}),
}), { expiresIn: 900 });
export const signedUpload = async (key: string, size: number) => {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 250 * 1024 * 1024)
    throw new AppError(413, 'Upload must be between 1 byte and 250 MiB', 'FILE_TOO_LARGE');
  return createPresignedPost(client(true), { Bucket: storageConfig().bucket, Key: key, Expires: 900,
    Conditions: [['content-length-range', size, size]], Fields: { 'Content-Type': 'application/octet-stream' },
  });
};
export const assertStorageConfiguration = () => {
  if (process.env.NODE_ENV === 'production' && !objectStorageEnabled()) throw new Error('Production requires STORAGE_DRIVER=s3');
  if (process.env.STORAGE_DRIVER && !['s3', 'local'].includes(process.env.STORAGE_DRIVER)) throw new Error('Invalid STORAGE_DRIVER');
  if (objectStorageEnabled()) storageConfig();
};
