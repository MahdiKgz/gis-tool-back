import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AppError } from "../middlewares/errorHandler";

export const isCadFile = (name: string): boolean => /\.(dwg|dgn)$/i.test(name);
export const normalizedCadPath = (source: string): string => `${source}.normalized.geojson`;
export const parseCadSourceCrs = (value: unknown): string => {
  if (typeof value !== "string" || !/^EPSG:[1-9]\d{3,5}$/i.test(value.trim())) {
    throw new AppError(400, "CAD uploads require a sourceCrs such as EPSG:32639.", "INVALID_SOURCE_CRS");
  }
  return value.trim().toUpperCase();
};

const CAD_ERRORS: Record<string, number> = {
  CAD_RUNTIME_UNAVAILABLE: 503,
  DGN_V8_UNAVAILABLE: 422,
  INVALID_SOURCE_CRS: 400,
  INVALID_CAD_FILE: 422,
  CAD_INVALID_COORDINATES: 422,
  CAD_NO_GEOMETRY: 422,
  CAD_OUTPUT_TOO_LARGE: 413,
  CAD_CONVERSION_TIMEOUT: 422,
  CAD_CONVERSION_WARNING: 422,
};

export type CadConverter = (source: string, output: string, sourceCrs: string) => Promise<void>;
let activeConversions = 0;

export const runCadConversion: CadConverter = async (source, output, sourceCrs) => {
  if (activeConversions >= 2) {
    throw new AppError(429, "The CAD converter is busy. Please retry shortly.", "CAD_CONVERTER_BUSY");
  }
  activeConversions++;
  let scratch: string | undefined;
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "snapgis-cad-run-"));
    await new Promise<void>((resolve, reject) => {
      const runtime = path.resolve(".cad-runtime");
      const grouped = process.platform !== "win32";
      const child = spawn(process.env.CAD_PYTHON ?? "python3", [
        path.resolve("scripts/cad_convert.py"), source, output, sourceCrs,
        process.env.CAD_DWGREAD ?? path.join(runtime, "bin/dwgread"),
      ], {
        detached: grouped,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          PYTHONPATH: process.env.CAD_PYTHONPATH ?? path.join(runtime, "python"),
          OPENBLAS_NUM_THREADS: "1",
          OMP_NUM_THREADS: "1",
          PROJ_NETWORK: "OFF",
          TMPDIR: scratch,
        },
      });
      let stderr = "";
      let limitError: AppError | undefined;
      const stop = () => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* The process may have already exited. */ }
      };
      const timeout = setTimeout(() => {
        limitError = new AppError(422, "CAD conversion exceeded the time limit.", "CAD_CONVERSION_TIMEOUT");
        stop();
      }, 90_000);
      child.stderr.on("data", (data: Buffer) => {
        if (stderr.length + data.length > 64 * 1024) {
          limitError = new AppError(422, "The CAD reader produced too many errors.", "INVALID_CAD_FILE");
          stop();
        } else stderr += data.toString("utf8");
      });
      child.once("error", () => {
        clearTimeout(timeout);
        stop();
        reject(new AppError(503, "The server CAD runtime could not be started.", "CAD_RUNTIME_UNAVAILABLE"));
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        stop();
        if (limitError) return reject(limitError);
        if (code === 0) return resolve();
        for (const line of stderr.trim().split("\n").reverse()) {
          try {
            const result = JSON.parse(line) as { code: string; message: string };
            const status = CAD_ERRORS[result.code];
            if (status && typeof result.message === "string") {
              return reject(new AppError(status, result.message, result.code));
            }
          } catch { /* Native reader diagnostics are not public API errors. */ }
        }
        reject(new AppError(422, "The CAD file could not be converted.", "INVALID_CAD_FILE"));
      });
    });
  } finally {
    activeConversions--;
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
};

export const createCadFileReader = (convert: CadConverter = runCadConversion) =>
  async (source: string, sourceCrs?: string): Promise<unknown> => {
    const target = normalizedCadPath(source);
    if (sourceCrs === undefined) {
      try {
        return JSON.parse(await fs.readFile(target, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AppError(410, "The normalized CAD source is no longer available. Upload the drawing again.", "CAD_SOURCE_EXPIRED");
        }
        throw error;
      }
    }
    const crs = parseCadSourceCrs(sourceCrs);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await convert(source, temporary, crs);
      if ((await fs.stat(temporary)).size > 50 * 1024 * 1024) {
        throw new AppError(413, "The converted CAD file is too large.", "CAD_OUTPUT_TOO_LARGE");
      }
      const data = JSON.parse(await fs.readFile(temporary, "utf8")) as { type?: unknown; features?: unknown };
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
        throw new AppError(422, "The drawing contains no convertible features.", "CAD_NO_GEOMETRY");
      }
      await fs.rename(temporary, target);
      return data;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };

export const readCadFile = createCadFileReader();
