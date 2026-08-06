export interface GeometryLike {
  type?: string;
  coordinates?: unknown;
  geometries?: GeometryLike[];
  [key: string]: unknown;
}

export interface GeoJsonFeatureLike {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: GeometryLike | null;
  [key: string]: unknown;
}

export interface FeatureCollectionLike {
  type?: string;
  features?: GeoJsonFeatureLike[];
  [key: string]: unknown;
}
