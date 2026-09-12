export interface CadImportReport {
  sourceCrs: string;
  targetCrs: "EPSG:4326";
  partial: boolean;
  warnings: Array<{
    code: "CAD_POLYGON_FALLBACK" | "CAD_MISSING_BLOCK";
    message: string;
    occurrences: number;
  }>;
}

/** Validate foreign GeoJSON metadata before exposing it in stored/public reports. */
export function cadImportReport(value: unknown): CadImportReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as CadImportReport;
  if (
    typeof report.sourceCrs !== "string" ||
    !/^EPSG:[1-9]\d{3,5}$/.test(report.sourceCrs) ||
    report.targetCrs !== "EPSG:4326" ||
    !Array.isArray(report.warnings) ||
    report.warnings.length > 100 ||
    !report.warnings.every(
      (w) =>
        w &&
        ["CAD_POLYGON_FALLBACK", "CAD_MISSING_BLOCK"].includes(w.code) &&
        typeof w.message === "string" &&
        w.message.length <= 512 &&
        Number.isSafeInteger(w.occurrences) &&
        w.occurrences > 0,
    )
  )
    return undefined;
  return {
    sourceCrs: report.sourceCrs,
    targetCrs: "EPSG:4326",
    partial: report.warnings.some((w) => w.code === "CAD_MISSING_BLOCK"),
    warnings: report.warnings.map(({ code, message, occurrences }) => ({
      code,
      message,
      occurrences,
    })),
  };
}
