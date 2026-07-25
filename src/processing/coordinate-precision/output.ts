import truncate from "@turf/truncate";

// Turf defaults to retaining at most three ordinates. SnapGIS supports
// consistent higher-dimensional positions, so the output rounding step must
// never splice Z/M or later ordinates.
export const prepareOutputCoordinates = <T>(
  geojson: T,
  precision = 9,
): T =>
  truncate(geojson as any, {
    precision,
    coordinates: Number.MAX_SAFE_INTEGER,
  }) as T;
