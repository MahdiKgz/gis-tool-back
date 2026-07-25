import { getFeatureId } from "../shared/feature-id";
import { visitGeometryPositions } from "../shared/geometry-positions";
import {
  FeatureCollectionLike,
  GeometryDimensionDetectionResult,
} from "./types";

const geometryGroupKey = (
  featureIndex: number,
  geometryCollectionPath: number[],
): string => `${featureIndex}|${geometryCollectionPath.join(".")}`;

export const detectGeometryDimensions = (
  geojson: FeatureCollectionLike,
): GeometryDimensionDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { positionsScanned: 0, findings: [] };
  }

  let positionsScanned = 0;
  const expectedByGeometry = new Map<string, number>();
  const findings: GeometryDimensionDetectionResult["findings"] = [];
  geojson.features.forEach((feature, featureIndex) => {
    visitGeometryPositions(feature.geometry, (candidate) => {
      positionsScanned++;
      const actualDimension = Array.isArray(candidate.value)
        ? candidate.value.length
        : null;
      const groupKey = geometryGroupKey(
        featureIndex,
        candidate.geometryCollectionPath,
      );
      const expectedDimension = expectedByGeometry.get(groupKey) ?? null;
      const base = {
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: candidate.geometryType,
        geometryCollectionPath: [...candidate.geometryCollectionPath],
        coordinatePath: [...candidate.coordinatePath],
        expectedDimension,
        actualDimension,
        repairable: false as const,
      };

      if (actualDimension === null || actualDimension < 2) {
        findings.push({
          ...base,
          code: "INVALID_POSITION_DIMENSION",
        });
        return;
      }
      if (
        !(candidate.value as unknown[]).every(
          (ordinate) =>
            typeof ordinate === "number" && Number.isFinite(ordinate),
        )
      ) {
        findings.push({
          ...base,
          code: "INVALID_COORDINATE_VALUE",
        });
        return;
      }
      if (expectedDimension === null) {
        expectedByGeometry.set(groupKey, actualDimension);
        return;
      }
      if (actualDimension !== expectedDimension) {
        findings.push({
          ...base,
          code: "INCONSISTENT_POSITION_DIMENSION",
        });
      }
    });
  });
  return { positionsScanned, findings };
};
