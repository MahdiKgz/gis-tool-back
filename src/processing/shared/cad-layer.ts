import type { GeoJsonFeatureLike } from "./geojson";

/** Older CAD imports used the OGR dataset name in snapgisCad.layer. */
export function cadLayer(feature: GeoJsonFeatureLike | undefined): string | null {
  const metadata = feature?.snapgisCad;
  const normalized = feature?.snapgisCadLayer;
  if (typeof normalized === "string") return normalized;
  if (!metadata || typeof metadata !== "object" || !("layer" in metadata)) return null;
  const layer = feature.properties?.Layer;
  if (typeof layer === "string" && layer.length > 0) return layer;
  const level = feature.properties?.Level;
  if (typeof level === "number" || (typeof level === "string" && level.length > 0)) {
    return metadata.layer === "elements" ? String(level) : `${metadata.layer}$${level}`;
  }
  return typeof metadata.layer === "string" ? metadata.layer : null;
}
