import { GeoJsonFeatureLike } from "./geojson";

export const getFeatureId = (
  feature: GeoJsonFeatureLike,
): string | number | null => {
  if (feature.id !== undefined) return feature.id;
  const propertyId = feature.properties?.id;
  return typeof propertyId === "string" || typeof propertyId === "number"
    ? propertyId
    : null;
};
