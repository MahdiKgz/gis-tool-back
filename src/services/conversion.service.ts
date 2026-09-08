import { isObjectReference, objectReference, objectKey, putStoredFile, copyStoredFile } from "./object-storage.service";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../middlewares/errorHandler";

export type ConversionFormat = "geojson" | "shapefile" | "dxf";
export interface ConversionOptions {
  inputFormat: ConversionFormat;
  targetFormat: ConversionFormat;
  sourceCRS?: string;
  targetCRS?: string;
}
export interface ConversionTask extends ConversionOptions {
  id: string;
  userId: string;
  directory: string;
  source: string;
}
export interface ConversionResult {
  features: number;
  sourceCRS: string;
  targetCRS: string;
  warnings: string[];
}
export const CONVERSION_ROOT = process.env.STORAGE_DRIVER === "s3" ? path.join(os.tmpdir(), "snapgis-conversions") : path.resolve("uploads/conversions");
export const SYNC_CONVERSION_BYTES = 5 * 1024 * 1024;
export const MAX_CONVERSION_MB = 250;
export const CONVERSION_RETENTION_SECONDS = 24 * 60 * 60;
export const conversionExtension = (format: ConversionFormat) =>
  format === "shapefile" ? "zip" : format;
export const conversionObjectKey = (task: ConversionTask, name: string) => `temporary/conversions/${objectKey(task.userId, task.id, 'conversion', name)}`;
export const conversionStoredOutput = (task: ConversionTask) => objectReference(conversionObjectKey(task, `converted.${conversionExtension(task.targetFormat)}`));
export const conversionOutput = (task: ConversionTask) =>
  path.join(
    task.directory,
    `converted.${conversionExtension(task.targetFormat)}`,
  );

const crsOption = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^EPSG:[1-9]\d{3,5}$/i.test(value.trim())) {
    throw new AppError(
      400,
      `${name} must be an EPSG identifier, for example EPSG:32639.`,
      name === "sourceCRS" ? "INVALID_SOURCE_CRS" : "INVALID_TARGET_CRS",
    );
  }
  return value.trim().toUpperCase();
};
export const parseConversionOptions = (
  name: string,
  body: Record<string, unknown>,
): ConversionOptions => {
  const extensions: Record<string, ConversionFormat> = {
    ".geojson": "geojson",
    ".json": "geojson",
    ".zip": "shapefile",
    ".dxf": "dxf",
  };
  const inputFormat = extensions[path.extname(name).toLowerCase()];
  if (!inputFormat)
    throw new AppError(
      400,
      "Use GeoJSON, a Shapefile ZIP, or DXF.",
      "UNSUPPORTED_CONVERSION_FORMAT",
    );
  const targetFormat =
    body.targetFormat === undefined || body.targetFormat === ""
      ? inputFormat
      : body.targetFormat;
  if (
    targetFormat !== "geojson" &&
    targetFormat !== "shapefile" &&
    targetFormat !== "dxf"
  ) {
    throw new AppError(
      400,
      "Unsupported target format.",
      "UNSUPPORTED_CONVERSION_FORMAT",
    );
  }
  const sourceCRS = crsOption(body.sourceCRS, "sourceCRS");
  const targetCRS = crsOption(body.targetCRS, "targetCRS");
  if (inputFormat === "dxf" && !sourceCRS)
    throw new AppError(
      400,
      "Specify the source CRS for DXF.",
      "SOURCE_CRS_REQUIRED",
    );
  return {
    inputFormat,
    targetFormat,
    ...(sourceCRS ? { sourceCRS } : {}),
    ...(targetCRS ? { targetCRS } : {}),
  };
};

export const createConversionDirectory = async (): Promise<{
  id: string;
  directory: string;
}> => {
  const id = randomUUID();
  const directory = path.join(CONVERSION_ROOT, id);
  await fs.mkdir(directory, { recursive: true });
  return { id, directory };
};
export const removeConversion = async (directory: string) => {
  if (path.dirname(path.resolve(directory)) !== CONVERSION_ROOT)
    throw new Error("Invalid conversion directory");
  await fs.rm(directory, { recursive: true, force: true });
};

const ERROR_STATUS: Record<string, number> = {
  CONVERSION_RUNTIME_UNAVAILABLE: 503,
  CONVERTER_BUSY: 429,
  CONVERSION_LIMIT_EXCEEDED: 413,
  CONVERSION_TIMEOUT: 422,
  INVALID_CONVERSION_FILE: 422,
  INVALID_SOURCE_CRS: 400,
  INVALID_TARGET_CRS: 400,
  SOURCE_CRS_REQUIRED: 400,
  CONVERSION_NO_GEOMETRY: 422,
  INVALID_CONVERSION_COORDINATES: 422,
  UNSUPPORTED_CONVERSION_GEOMETRY: 422,
  UNSUPPORTED_CONVERSION_ATTRIBUTES: 422,
  CONVERSION_DATA_LOSS: 422,
  UNSUPPORTED_CONVERSION_FORMAT: 400,
};
let active = 0;
export const runConversion = async (
  task: ConversionTask,
  signal?: AbortSignal,
): Promise<ConversionResult> => {
  if (active >= 2)
    throw new AppError(
      429,
      "Conversion is busy. Try again shortly.",
      "CONVERTER_BUSY",
    );
  if (signal?.aborted)
    throw new AppError(499, "Conversion cancelled.", "CONVERSION_CANCELLED");
  active++;
  const output = conversionOutput(task);
  try {
    const configPath = path.join(task.directory, "request.json");
    await fs.writeFile(configPath, JSON.stringify({ ...task, output }), "utf8");
    await new Promise<void>((resolve, reject) => {
      const grouped = process.platform !== "win32";
      const child = spawn(
        process.env.CAD_PYTHON ?? "python3",
        [path.resolve("scripts/format_convert.py"), configPath],
        {
          detached: grouped,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            PYTHONPATH:
              process.env.CAD_PYTHONPATH ?? path.resolve(".cad-runtime/python"),
            OPENBLAS_NUM_THREADS: "1",
            OMP_NUM_THREADS: "1",
            PROJ_NETWORK: "OFF",
            TMPDIR: task.directory,
          },
        },
      );
      let stderr = "";
      let failure: AppError | undefined;
      const kill = () => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already stopped. */
        }
      };
      const cancel = () => {
        failure = new AppError(
          499,
          "Conversion cancelled.",
          "CONVERSION_CANCELLED",
        );
        kill();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const timer = setTimeout(() => {
        failure = new AppError(
          422,
          "Conversion exceeded the time limit.",
          "CONVERSION_TIMEOUT",
        );
        kill();
      }, 300_000);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        kill();
      };
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length + chunk.length > 65536) {
          failure = new AppError(
            422,
            "Too many converter diagnostics.",
            "INVALID_CONVERSION_FILE",
          );
          kill();
        } else stderr += chunk.toString("utf8");
      });
      child.once("error", () => {
        finish();
        reject(
          new AppError(
            503,
            "The conversion runtime is unavailable.",
            "CONVERSION_RUNTIME_UNAVAILABLE",
          ),
        );
      });
      child.once("close", (code) => {
        finish();
        if (failure) return reject(failure);
        if (code === 0) return resolve();
        for (const line of stderr.trim().split("\n").reverse()) {
          try {
            const data = JSON.parse(line) as { code: string; message: string };
            if (ERROR_STATUS[data.code] && typeof data.message === "string")
              return reject(
                new AppError(ERROR_STATUS[data.code]!, data.message, data.code),
              );
          } catch {
            /* Do not expose native diagnostic paths. */
          }
        }
        reject(
          new AppError(
            422,
            "File conversion failed.",
            "INVALID_CONVERSION_FILE",
          ),
        );
      });
    });
    const size = (await fs.stat(output)).size;
    if (!size || size > 500 * 1024 * 1024)
      throw new AppError(
        413,
        "Converted output exceeds the limit.",
        "CONVERSION_LIMIT_EXCEEDED",
      );
    const result = JSON.parse(
      await fs.readFile(path.join(task.directory, "result.json"), "utf8"),
    ) as ConversionResult;
    return result;
  } catch (error) {
    await fs.rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    active--;
    await fs
      .rm(path.join(task.directory, "work"), { recursive: true, force: true })
      .catch(() => {});
  }
};

export const cleanExpiredConversions = async (now = Date.now()) => {
  const entries = await fs
    .readdir(CONVERSION_ROOT, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const directory = path.join(CONVERSION_ROOT, entry.name);
    const stat = await fs.stat(directory).catch(() => null);
    if (stat && now - stat.mtimeMs > CONVERSION_RETENTION_SECONDS * 1000)
      await removeConversion(directory);
  }
};

export interface ConversionJobResult {
  result?: ConversionResult;
  error?: { code: string; message: string };
}
export const processConversionJob = async (
  task: ConversionTask,
  convert = runConversion,
): Promise<ConversionJobResult> => {
  let localDirectory: string | undefined;
  try {
    if (isObjectReference(task.source)) {
      const created = await createConversionDirectory();
      localDirectory = created.directory;
      const source = path.join(localDirectory, `input.${conversionExtension(task.inputFormat)}`);
      await copyStoredFile(task.source, source, MAX_CONVERSION_MB * 1024 * 1024);
      const local = { ...task, source, directory: localDirectory };
      const result = await convert(local);
      await putStoredFile(conversionObjectKey(task, `converted.${conversionExtension(task.targetFormat)}`), conversionOutput(local));
      return { result };
    }
    return { result: await convert(task) };
  } catch (error) {
    await removeConversion(task.directory).catch(() => {});
    return {
      error: {
        code:
          error instanceof AppError
            ? (error.code ?? "CONVERSION_FAILED")
            : "CONVERSION_FAILED",
        message:
          error instanceof AppError ? error.message : "Conversion failed.",
      },
    };
  } finally {
    if (localDirectory) await removeConversion(localDirectory).catch(() => {});
    // Queued object inputs remain available until the temporary-prefix lifecycle expires them.
  }
};
