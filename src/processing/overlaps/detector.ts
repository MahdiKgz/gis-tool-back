import area from "@turf/area";
import bbox from "@turf/bbox";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import { Position } from "../shared/coordinates";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  FeatureCollectionLike,
  PolygonOverlapDetectionResult,
} from "./types";

// Turf can return a minuscule positive-area artefact for exact shared edges.
// This is far below a meaningful cadastral overlap while remaining above the
// observed floating-point noise floor.
const FLOAT_EDGE_EPSILON_M2 = 1e-8;

interface PolygonRecord {
  componentIndex: number;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  coordinates: Position[][];
  areaM2: number;
  feature: ReturnType<typeof polygon>;
  bounds: [number, number, number, number];
}

interface IndexedPolygon {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  componentIndex: number;
}

const componentBounds = (
  coordinates: Position[][],
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

const collectPolygons = (
  geojson: FeatureCollectionLike,
): PolygonRecord[] => {
  const polygons: PolygonRecord[] = [];
  if (!Array.isArray(geojson.features)) return polygons;

  geojson.features.forEach((sourceFeature, featureIndex) => {
    visitPolygonComponents(sourceFeature.geometry, (component) => {
      try {
        const feature = polygon(component.coordinates as any);
        const areaM2 = area(feature);
        if (!Number.isFinite(areaM2) || areaM2 <= 0) return;
        polygons.push({
          componentIndex: polygons.length,
          featureIndex,
          featureId: getFeatureId(sourceFeature),
          geometryType: component.geometryType,
          geometryCollectionPath: [...component.geometryCollectionPath],
          polygonPath: [...component.polygonPath],
          coordinates: component.coordinates,
          areaM2,
          feature,
          bounds: componentBounds(component.coordinates),
        });
      } catch {
        // Earlier structural/topology checks own malformed polygon reporting.
      }
    });
  });
  return polygons;
};

export const detectPolygonOverlaps = (
  geojson: FeatureCollectionLike,
): PolygonOverlapDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return {
      polygonComponentsScanned: 0,
      candidatePairsChecked: 0,
      findings: [],
    };
  }

  const polygons = collectPolygons(geojson);
  const spatialIndex = new RBush<IndexedPolygon>();
  spatialIndex.load(
    polygons.map((record) => {
      const [minX, minY, maxX, maxY] = record.bounds;
      return {
        minX,
        minY,
        maxX,
        maxY,
        componentIndex: record.componentIndex,
      };
    }),
  );

  let candidatePairsChecked = 0;
  const findings: PolygonOverlapDetectionResult["findings"] = [];
  for (const first of polygons) {
    const [minX, minY, maxX, maxY] = first.bounds;
    for (const candidate of spatialIndex.search({ minX, minY, maxX, maxY })) {
      if (candidate.componentIndex <= first.componentIndex) continue;
      const second = polygons[candidate.componentIndex]!;
      if (second.featureIndex === first.featureIndex) continue;
      candidatePairsChecked++;

      try {
        const overlap = intersect(
          featureCollection([first.feature, second.feature]),
        );
        if (!overlap) continue;
        const overlapAreaM2 = area(overlap);
        if (
          !Number.isFinite(overlapAreaM2) ||
          overlapAreaM2 <= FLOAT_EDGE_EPSILON_M2
        ) {
          continue;
        }
        findings.push({
          code: "POLYGON_OVERLAP",
          featureIndex: first.featureIndex,
          featureId: first.featureId,
          relatedFeatureIndex: second.featureIndex,
          relatedFeatureId: second.featureId,
          geometryType: first.geometryType,
          relatedGeometryType: second.geometryType,
          geometryCollectionPath: [...first.geometryCollectionPath],
          relatedGeometryCollectionPath: [
            ...second.geometryCollectionPath,
          ],
          polygonPath: [...first.polygonPath],
          relatedPolygonPath: [...second.polygonPath],
          overlapAreaM2,
          overlapRatio:
            overlapAreaM2 / Math.min(first.areaM2, second.areaM2),
          overlapBbox: bbox(overlap) as [number, number, number, number],
          repairable: false,
        });
      } catch {
        // Invalid polygon relationships are reported by earlier checks.
      }
    }
  }

  return {
    polygonComponentsScanned: polygons.length,
    candidatePairsChecked,
    findings,
  };
};
