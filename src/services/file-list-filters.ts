import type { Prisma } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";

export interface FileListFilters {
  search?: string;
  fileType?: "geojson" | "json" | "kml" | "kmz" | "shp" | "zip" | "dwg" | "dgn";
  hasIssues?: boolean;
  uploadedFrom?: string;
  uploadedTo?: string;
}
const invalid = (field: string): never => { throw new AppError(400, `Invalid ${field} filter`, "INVALID_FILE_FILTER"); };
export function parseFileFilters(query: Record<string, unknown>): FileListFilters {
  const filters: FileListFilters = {};
  for (const key of ["search", "fileType", "hasIssues", "uploadedFrom", "uploadedTo"] as const) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") invalid(key);
    const text = value as string;
    if (key === "search") {
      if (text.trim().length > 150) invalid(key);
      if (text.trim()) filters.search = text.trim();
    } else if (key === "fileType") {
      if (!["geojson", "json", "kml", "kmz", "shp", "zip", "dwg", "dgn"].includes(text)) invalid(key);
      filters.fileType = text as FileListFilters["fileType"] & string;
    } else if (key === "hasIssues") {
      if (text !== "true" && text !== "false") invalid(key);
      filters.hasIssues = text === "true";
    } else {
      const date = new Date(text);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) invalid(key);
      filters[key] = text;
    }
  }
  if (filters.uploadedFrom && filters.uploadedTo && filters.uploadedFrom >= filters.uploadedTo) invalid("date range");
  return filters;
}
export function buildUploadWhere(userId: string, filters: FileListFilters = {}): Prisma.UploadedFileWhereInput {
  const where: Prisma.UploadedFileWhereInput = { userId };
  if (filters.search) {
    // Prisma contains uses SQL LIKE; treat user-entered wildcard characters literally.
    const contains = filters.search.replace(/[\\%_]/g, "\\$&");
    where.OR = [{ name: { contains, mode: "insensitive" } }, { originalName: { contains, mode: "insensitive" } }];
  }
  if (filters.fileType) where.originalName = { endsWith: `.${filters.fileType}`, mode: "insensitive" };
  if (filters.hasIssues !== undefined) where.identifiedIssues = filters.hasIssues ? { gt: 0 } : 0;
  if (filters.uploadedFrom || filters.uploadedTo) where.createdAt = {
    ...(filters.uploadedFrom ? { gte: new Date(filters.uploadedFrom) } : {}),
    ...(filters.uploadedTo ? { lt: new Date(filters.uploadedTo) } : {}),
  };
  return where;
}
