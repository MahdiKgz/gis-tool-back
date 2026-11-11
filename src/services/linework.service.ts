import { cadLayer } from "../processing/shared/cad-layer";
import type {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
  GeometryLike,
} from "../processing/shared/geojson";

function linework(geometry: GeometryLike): GeometryLike {
  const { type, coordinates } = geometry;
  if (!Array.isArray(coordinates)) {
    if (type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
      return { ...geometry, geometries: geometry.geometries.map(linework) };
    }
    return geometry;
  }
  switch (type) {
    case "Polygon":
      return { type: "MultiLineString", coordinates };
    case "MultiPolygon":
      return { type: "MultiLineString", coordinates: coordinates.flat() };
    case "LineString":
      return { type: "MultiLineString", coordinates: [coordinates] };
    default:
      return geometry;
  }
}

export function buildLinework<T extends FeatureCollectionLike>(
  collection: T,
): Omit<T, "features"> & { features: GeoJsonFeatureLike[] | undefined } {
  return {
    ...collection,
    features: collection.features?.map((feature) => {
      const layer = cadLayer(feature);
      return {
        ...feature,
        ...(layer === null ? {} : { properties: { ...feature.properties, Layer: layer } }),
        ...(feature.geometry ? { geometry: linework(feature.geometry) } : {}),
      };
    }),
  };
}
