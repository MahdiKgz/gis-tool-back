import { getFeatureId } from "../shared/feature-id";
import {
  FeatureCollectionLike,
  GeometryTypeDetectionResult,
  GeometryTypeFindingCode,
  SupportedGeometryType,
} from "./types";

export const SUPPORTED_GEOMETRY_TYPES = new Set<SupportedGeometryType>([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const detectGeometryTypes = (
  geojson: FeatureCollectionLike,
): GeometryTypeDetectionResult => {
  if (geojson.type !== "FeatureCollection") {
    return {
      rootValid: false,
      rootError: "GeoJSON root type must be FeatureCollection",
      geometriesScanned: 0,
      findings: [],
    };
  }
  if (!Array.isArray(geojson.features)) {
    return {
      rootValid: false,
      rootError: "FeatureCollection features must be an array",
      geometriesScanned: 0,
      findings: [],
    };
  }

  let geometriesScanned = 0;
  const findings: GeometryTypeDetectionResult["findings"] = [];

  geojson.features.forEach((feature, featureIndex) => {
    if (!isObject(feature)) {
      findings.push({
        code: "INVALID_FEATURE_OBJECT",
        featureIndex,
        featureId: null,
        geometryCollectionPath: [],
        receivedType: null,
        repairable: false,
      });
      return;
    }
    const featureId = getFeatureId(feature);
    const addFinding = (
      code: GeometryTypeFindingCode,
      geometryCollectionPath: number[],
      receivedType: string | null,
    ): void => {
      findings.push({
        code,
        featureIndex,
        featureId,
        geometryCollectionPath: [...geometryCollectionPath],
        receivedType,
        repairable: false,
      });
    };

    const visit = (
      geometry: unknown,
      geometryCollectionPath: number[],
      allowNull: boolean,
    ): void => {
      if (geometry === null && allowNull) return;
      if (!isObject(geometry)) {
        addFinding(
          "INVALID_GEOMETRY_OBJECT",
          geometryCollectionPath,
          null,
        );
        return;
      }
      geometriesScanned++;
      const receivedType =
        typeof geometry.type === "string" ? geometry.type : null;
      if (receivedType === null) {
        addFinding(
          "MISSING_GEOMETRY_TYPE",
          geometryCollectionPath,
          null,
        );
        return;
      }
      if (
        !SUPPORTED_GEOMETRY_TYPES.has(
          receivedType as SupportedGeometryType,
        )
      ) {
        addFinding(
          "UNSUPPORTED_GEOMETRY_TYPE",
          geometryCollectionPath,
          receivedType,
        );
        return;
      }
      if (receivedType !== "GeometryCollection") return;
      if (!Array.isArray(geometry.geometries)) {
        addFinding(
          "INVALID_GEOMETRY_COLLECTION",
          geometryCollectionPath,
          receivedType,
        );
        return;
      }
      geometry.geometries.forEach((child, childIndex) =>
        visit(child, [...geometryCollectionPath, childIndex], false),
      );
    };

    visit(feature.geometry, [], true);
  });

  return {
    rootValid: true,
    rootError: null,
    geometriesScanned,
    findings,
  };
};
