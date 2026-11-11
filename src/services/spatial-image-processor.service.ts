import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { database } from "./database.service";
import {
  copyStoredFile, objectReference, putStoredArchive, removeStoredFile,
  snapshotStoredObject, storedObjectStat,
} from "./object-storage.service";
import { imageArchive, imageOriginal, imageStagingKey, MAX_SPATIAL_IMAGE_BYTES } from "./spatial-image.service";

const exec = promisify(execFile);
const PREVIEW_EDGE = 16384;
const HOUR = 60 * 60 * 1000;

class InvalidSpatialImage extends Error {}

interface TiffBand {
  band: number;
  type: string;
  colorInterpretation: string;
}

export const tiffPreviewOptions = (info: {
  driverShortName?: string;
  size?: [number, number];
  geoTransform?: [number, number, number, number, number, number];
  coordinateSystem?: { wkt?: string };
  bands?: TiffBand[];
}) => {
  const { size, bands, geoTransform } = info;
  const firstBand = bands?.[0];
  if (info.driverShortName !== "GTiff" || !info.coordinateSystem?.wkt || !size ||
      !size.every((value) => Number.isSafeInteger(value) && value > 0) ||
      geoTransform?.length !== 6 || !geoTransform.every(Number.isFinite) ||
      geoTransform[1] * geoTransform[5] === geoTransform[2] * geoTransform[4] ||
      !bands || !firstBand)
    throw new InvalidSpatialImage("Missing or invalid TIFF georeferencing");

  const ratio = Math.min(1, PREVIEW_EDGE / Math.max(...size));
  const dimensions = size.map((value) => String(Math.max(1, Math.round(value * ratio))));
  const findBand = (name: string) => bands.find((band) => band.colorInterpretation === name);
  const rgb = ["Red", "Green", "Blue"].map(findBand);
  const palette = firstBand.colorInterpretation === "Palette";
  const visible = rgb.every((band) => band !== undefined) ? rgb : [firstBand];
  const alpha = findBand("Alpha");
  if (alpha && !palette && !visible.includes(alpha)) visible.push(alpha);

  return [
    "-outsize", ...dimensions, "-r", "average",
    ...visible.flatMap((band) => ["-b", String(band.band)]),
    ...(palette ? ["-expand", "rgba"] : []),
    ...(visible.some((band) => band.type !== "Byte") ? ["-ot", "Byte", "-scale"] : []),
  ];
};

const command = (executable: string, args: string[], cwd: string) =>
  exec(executable, args, {
    cwd, timeout: HOUR, maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      GDAL_DATA: process.env.GDAL_DATA, PROJ_DATA: process.env.PROJ_DATA, PROJ_NETWORK: "OFF",
      GDAL_PAM_ENABLED: "NO", GDAL_CACHEMAX: "128", GDAL_NUM_THREADS: "2",
    },
  });

export const createSpatialArchive = async (directory: string) => {
  const gdalInfo = process.env.GDAL_INFO_BIN || "gdalinfo";
  const gdalTranslate = process.env.GDAL_TRANSLATE_BIN || "gdal_translate";
  const gdalAddo = process.env.GDAL_ADDO_BIN || "gdaladdo";
  const pmtiles = process.env.PMTILES_BIN || "pmtiles";
  let info;
  try {
    const result = await command(gdalInfo, ["-if", "GTiff", "-json", "-nomd", "-noct", "original.tiff"], directory);
    info = JSON.parse(result.stdout);
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === "number" && !(error as { killed?: boolean }).killed)
      throw new InvalidSpatialImage("Unreadable TIFF");
    throw error;
  }

  const options = tiffPreviewOptions(info);
  await command(gdalTranslate, [
    "-if", "GTiff", "-of", "MBTILES", "-co", "TILE_FORMAT=PNG",
    ...options, "original.tiff", "map.mbtiles",
  ], directory);
  const metadata = await command(gdalInfo, ["-json", "map.mbtiles"], directory);
  const zoom = Number(JSON.parse(metadata.stdout).metadata?.[""]?.ZOOM_LEVEL);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 30) throw new Error("Invalid raster tile zoom");
  if (zoom > 0) {
    const factors = Array.from({ length: zoom }, (_, index) => String(2 ** (index + 1)));
    await command(gdalAddo, ["-r", "average", "map.mbtiles", ...factors], directory);
  }
  await command(pmtiles, ["convert", "map.mbtiles", "map.pmtiles"], directory);
  return path.join(directory, "map.pmtiles");
};

export const failSpatialImage = (id: string, errorCode: string) => database.spatialImage.updateMany({
  where: { id, status: "processing" },
  data: { status: "failed", errorCode, uploadETag: null },
});

export const processSpatialImage = async (id: string) => {
  const image = await database.spatialImage.findFirst({ where: { id, status: "processing" } });
  if (!image?.uploadETag) return;
  const directory = await fs.mkdtemp(path.join(process.env.SPATIAL_IMAGE_TMP_DIR || os.tmpdir(), "snapgis-raster-"));
  const original = imageOriginal(image);
  const staging = objectReference(imageStagingKey(image));

  try {
    const snapshot = await storedObjectStat(original).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!snapshot) await snapshotStoredObject(staging, original, image.uploadETag);
    await copyStoredFile(original, path.join(directory, "original.tiff"), MAX_SPATIAL_IMAGE_BYTES);
    const archive = await createSpatialArchive(directory);
    await putStoredArchive(imageArchive(image), archive);
    await database.spatialImage.updateMany({
      where: { id, status: "processing" },
      data: { status: "ready", uploadETag: null },
    });
  } catch (error) {
    if (!(error instanceof InvalidSpatialImage)) throw error;
    await failSpatialImage(id, "INVALID_GEOTIFF");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  await removeStoredFile(staging).catch((error) => console.warn("Spatial image staging cleanup failed", id, error));
};
