import area from "@turf/area";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import { GeometryLike } from "../shared/geojson";
import { isValidPolygonCoordinates } from "../shared/polygon-components";
import { canonicalRingSignature } from "../shared/ring-signature";
import {
  FeatureCollectionLike,
  MultipartIntegrityDetectionResult,
  MultipartIntegrityFindingCode,
} from "./types";

interface IndexedComponent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  index: number;
}

const componentSignature = (coordinates: number[][][]): string => {
  const exterior = canonicalRingSignature(coordinates[0]!);
  const holes = coordinates
    .slice(1)
    .map((ring) => canonicalRingSignature(ring))
    .sort();
  return `${exterior}::${holes.join("::")}`;
};

const componentBounds = (
  coordinates: number[][][],
): [number, number, number, number] => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ring of coordinates) {
    for (const position of ring) {
      minX = Math.min(minX, position[0]!);
      minY = Math.min(minY, position[1]!);
      maxX = Math.max(maxX, position[0]!);
      maxY = Math.max(maxY, position[1]!);
    }
  }
  return [minX, minY, maxX, maxY];
};

export const detectMultipartIntegrity = (
  geojson: FeatureCollectionLike,
): MultipartIntegrityDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return {
      multiPolygonsScanned: 0,
      polygonComponentsScanned: 0,
      findings: [],
    };
  }

  let multiPolygonsScanned = 0;
  let polygonComponentsScanned = 0;
  const findings: MultipartIntegrityDetectionResult["findings"] = [];

  geojson.features.forEach((feature, featureIndex) => {
    const visit = (
      geometry: GeometryLike | null | undefined,
      geometryCollectionPath: number[] = [],
    ): void => {
      if (!geometry?.type) return;
      if (geometry.type === "GeometryCollection") {
        if (!Array.isArray(geometry.geometries)) return;
        geometry.geometries.forEach((child, index) =>
          visit(child, [...geometryCollectionPath, index]),
        );
        return;
      }
      if (geometry.type !== "MultiPolygon") return;
      multiPolygonsScanned++;
      const coordinates = geometry.coordinates;
      const addFinding = (
        code: MultipartIntegrityFindingCode,
        polygonPath: number[] | null,
        relatedPolygonPath: number[] | null = null,
        overlapAreaM2: number | null = null,
      ): void => {
        findings.push({
          code,
          featureIndex,
          featureId: getFeatureId(feature),
          geometryCollectionPath: [...geometryCollectionPath],
          polygonPath,
          relatedPolygonPath,
          overlapAreaM2,
          repairable: false,
        });
      };

      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        addFinding("EMPTY_MULTIPOLYGON", null);
        return;
      }

      const validComponents: Array<{
        originalIndex: number;
        feature: ReturnType<typeof polygon>;
        signature: string;
        bounds: [number, number, number, number];
      }> = [];
      coordinates.forEach((component, componentIndex) => {
        polygonComponentsScanned++;
        if (!isValidPolygonCoordinates(component)) {
          addFinding("INVALID_POLYGON_COMPONENT", [componentIndex]);
          return;
        }
        const componentFeature = polygon(component as any);
        validComponents.push({
          originalIndex: componentIndex,
          feature: componentFeature,
          signature: componentSignature(component),
          bounds: componentBounds(component),
        });
      });
      if (validComponents.length < 2) return;

      const spatialIndex = new RBush<IndexedComponent>();
      spatialIndex.load(
        validComponents.map((component, index) => {
          const [minX, minY, maxX, maxY] = component.bounds;
          return { minX, minY, maxX, maxY, index };
        }),
      );

      for (let firstIndex = 0; firstIndex < validComponents.length; firstIndex++) {
        const first = validComponents[firstIndex]!;
        const [minX, minY, maxX, maxY] = first.bounds;
        for (const candidate of spatialIndex.search({
          minX,
          minY,
          maxX,
          maxY,
        })) {
          if (candidate.index <= firstIndex) continue;
          const second = validComponents[candidate.index]!;
          if (first.signature === second.signature) {
            addFinding(
              "DUPLICATE_POLYGON_COMPONENT",
              [second.originalIndex],
              [first.originalIndex],
            );
            continue;
          }
          let overlapAreaM2 = 0;
          try {
            const overlap = intersect(
              featureCollection([first.feature, second.feature]),
            );
            overlapAreaM2 = overlap ? area(overlap) : 0;
          } catch {
            continue;
          }
          if (overlapAreaM2 <= 0) continue;
          addFinding(
            "OVERLAPPING_POLYGON_COMPONENTS",
            [second.originalIndex],
            [first.originalIndex],
            overlapAreaM2,
          );
        }
      }
    };
    visit(feature.geometry);
  });

  return {
    multiPolygonsScanned,
    polygonComponentsScanned,
    findings,
  };
};
