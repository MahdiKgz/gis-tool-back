import area from "@turf/area";
import booleanIntersects from "@turf/boolean-intersects";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import { Position } from "../shared/coordinates";
import { GeoJsonFeatureLike } from "../shared/geojson";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  expandBoundsByMeters,
  segmentBounds,
  SpatialBounds,
} from "../shared/spatial-segments";
import { FeatureCollectionLike, SliverFinding } from "./types";

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;
const SHARED_EDGE_EPSILON_METERS = 1e-4;
const POSITIVE_OVERLAP_EPSILON_M2 = 1e-8;

interface IndexedExteriorSegment extends SpatialBounds {
  componentKey: string;
  featureIndex: number;
  start: Position;
  end: Position;
}

interface ComponentMetrics {
  areaM2: number;
  feature: ReturnType<typeof polygon>;
  segments: IndexedExteriorSegment[];
}

const hasBoundaryOnlyContact = (
  source: ReturnType<typeof polygon>,
  target: GeoJsonFeatureLike,
): boolean => {
  try {
    if (!booleanIntersects(source, target as any)) return false;
    const overlap = intersect(featureCollection([source, target as any]));
    return !overlap || area(overlap) <= POSITIVE_OVERLAP_EPSILON_M2;
  } catch {
    return false;
  }
};

export interface SliverAdjacencyEvidence {
  targetFeatureIndex: number;
  targetFeatureId: string | number | null;
  sharedBoundaryLengthMeters: number;
  sharedBoundaryRatio: number;
  dominanceRatio: number | null;
  targetAreaRatio: number;
}

export const sliverComponentKey = (
  featureIndex: number,
  geometryCollectionPath: number[],
  polygonPath: number[],
): string =>
  `${featureIndex}|${geometryCollectionPath.join(".")}|${polygonPath.join(".")}`;

const projectPositions = (
  positions: Position[],
): Array<{ x: number; y: number }> => {
  const originLongitude = positions[0]![0]!;
  const originLatitude =
    positions.reduce((sum, position) => sum + position[1]!, 0) /
    positions.length;
  const longitudeScale =
    Math.cos(originLatitude * DEGREES_TO_RADIANS) * EARTH_RADIUS_METERS;
  return positions.map((position) => ({
    x:
      (position[0]! - originLongitude) *
      DEGREES_TO_RADIANS *
      longitudeScale,
    y:
      (position[1]! - originLatitude) *
      DEGREES_TO_RADIANS *
      EARTH_RADIUS_METERS,
  }));
};

const collinearOverlapMeters = (
  first: IndexedExteriorSegment,
  second: IndexedExteriorSegment,
): number => {
  const [firstStart, firstEnd, secondStart, secondEnd] = projectPositions([
    first.start,
    first.end,
    second.start,
    second.end,
  ]);
  const deltaX = firstEnd!.x - firstStart!.x;
  const deltaY = firstEnd!.y - firstStart!.y;
  const firstLength = Math.hypot(deltaX, deltaY);
  if (firstLength <= Number.EPSILON) return 0;
  const unitX = deltaX / firstLength;
  const unitY = deltaY / firstLength;
  const signedOffset = (point: { x: number; y: number }): number =>
    (point.x - firstStart!.x) * -unitY +
    (point.y - firstStart!.y) * unitX;
  if (
    Math.abs(signedOffset(secondStart!)) > SHARED_EDGE_EPSILON_METERS ||
    Math.abs(signedOffset(secondEnd!)) > SHARED_EDGE_EPSILON_METERS
  ) {
    return 0;
  }
  const projection = (point: { x: number; y: number }): number =>
    (point.x - firstStart!.x) * unitX +
    (point.y - firstStart!.y) * unitY;
  const secondStartProjection = projection(secondStart!);
  const secondEndProjection = projection(secondEnd!);
  const overlapStart = Math.max(
    0,
    Math.min(secondStartProjection, secondEndProjection),
  );
  const overlapEnd = Math.min(
    firstLength,
    Math.max(secondStartProjection, secondEndProjection),
  );
  return Math.max(0, overlapEnd - overlapStart);
};

const collectComponents = (
  geojson: FeatureCollectionLike,
): {
  componentMetrics: Map<string, ComponentMetrics>;
  featureAreas: Map<number, number>;
  segments: IndexedExteriorSegment[];
} => {
  const componentMetrics = new Map<string, ComponentMetrics>();
  const featureAreas = new Map<number, number>();
  const segments: IndexedExteriorSegment[] = [];
  geojson.features?.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      const key = sliverComponentKey(
        featureIndex,
        component.geometryCollectionPath,
        component.polygonPath,
      );
      let componentFeature: ReturnType<typeof polygon>;
      let componentAreaM2 = 0;
      try {
        componentFeature = polygon(component.coordinates as any);
        componentAreaM2 = area(componentFeature);
      } catch {
        return;
      }
      const componentSegments = component.coordinates[0]!
        .slice(0, -1)
        .flatMap((start, segmentIndex) => {
          const end = component.coordinates[0]![segmentIndex + 1]!;
          if (start[0] === end[0] && start[1] === end[1]) return [];
          const segment: IndexedExteriorSegment = {
            ...segmentBounds(start, end),
            componentKey: key,
            featureIndex,
            start,
            end,
          };
          return [segment];
        });
      componentMetrics.set(key, {
        areaM2: componentAreaM2,
        feature: componentFeature,
        segments: componentSegments,
      });
      featureAreas.set(
        featureIndex,
        (featureAreas.get(featureIndex) ?? 0) + componentAreaM2,
      );
      segments.push(...componentSegments);
    });
  });
  return { componentMetrics, featureAreas, segments };
};

export const findSliverAdjacency = (
  geojson: FeatureCollectionLike,
  findings: SliverFinding[],
): Map<string, SliverAdjacencyEvidence> => {
  const result = new Map<string, SliverAdjacencyEvidence>();
  if (!geojson.features || findings.length === 0) return result;
  const { componentMetrics, featureAreas, segments } =
    collectComponents(geojson);
  const spatialIndex = new RBush<IndexedExteriorSegment>();
  spatialIndex.load(segments);

  for (const finding of findings) {
    const key = sliverComponentKey(
      finding.featureIndex,
      finding.geometryCollectionPath,
      finding.polygonPath,
    );
    const component = componentMetrics.get(key);
    if (!component || finding.perimeterMeters <= 0 || finding.areaM2 <= 0) {
      continue;
    }
    const sharedByFeature = new Map<number, number>();
    for (const first of component.segments) {
      const candidates = spatialIndex.search(
        expandBoundsByMeters(first, SHARED_EDGE_EPSILON_METERS),
      );
      for (const second of candidates) {
        if (
          second.featureIndex === finding.featureIndex ||
          second.componentKey === first.componentKey
        ) {
          continue;
        }
        const overlap = collinearOverlapMeters(first, second);
        if (overlap <= SHARED_EDGE_EPSILON_METERS) continue;
        sharedByFeature.set(
          second.featureIndex,
          (sharedByFeature.get(second.featureIndex) ?? 0) + overlap,
        );
      }
    }
    const ranked = [...sharedByFeature.entries()]
      .map(([featureIndex, sharedBoundaryLengthMeters]) => ({
        featureIndex,
        sharedBoundaryLengthMeters: Math.min(
          sharedBoundaryLengthMeters,
          finding.perimeterMeters,
        ),
      }))
      .filter(({ featureIndex }) => {
        const targetFeature = geojson.features?.[featureIndex];
        return (
          targetFeature !== undefined &&
          hasBoundaryOnlyContact(component.feature, targetFeature)
        );
      })
      .sort(
        (first, second) =>
          second.sharedBoundaryLengthMeters - first.sharedBoundaryLengthMeters ||
          first.featureIndex - second.featureIndex,
      );
    const dominant = ranked[0];
    if (!dominant) continue;
    const runnerUp = ranked[1];
    const targetAreaM2 = featureAreas.get(dominant.featureIndex) ?? 0;
    const targetFeature = geojson.features[dominant.featureIndex];
    if (!targetFeature) continue;
    result.set(key, {
      targetFeatureIndex: dominant.featureIndex,
      targetFeatureId: getFeatureId(targetFeature),
      sharedBoundaryLengthMeters: dominant.sharedBoundaryLengthMeters,
      sharedBoundaryRatio:
        dominant.sharedBoundaryLengthMeters / finding.perimeterMeters,
      dominanceRatio:
        runnerUp && runnerUp.sharedBoundaryLengthMeters > 0
          ? dominant.sharedBoundaryLengthMeters /
            runnerUp.sharedBoundaryLengthMeters
          : null,
      targetAreaRatio: targetAreaM2 / finding.areaM2,
    });
  }
  return result;
};
