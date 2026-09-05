import kinks from "@turf/kinks";
import { polygon } from "@turf/helpers";
import unkinkPolygon from "@turf/unkink-polygon";
import { detectMultipartIntegrity } from "../multipart-integrity";
import {
  calculateRingOrientation,
  RingOrientation,
} from "../ring-orientation";
import {
  isFinitePosition,
  Position,
  positionsEqual,
} from "../shared/coordinates";
import { GeoJsonFeatureLike } from "../shared/geojson";
import { detectSelfIntersections } from "./detector";
import {
  FeatureCollectionLike,
  SelfIntersectionFinding,
  SelfIntersectionRepairFailureReason,
} from "./types";

export interface SelfIntersectionRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedKeys: Set<string>;
  failedReasons: Map<string, SelfIntersectionRepairFailureReason>;
}

type FeatureRepairAttempt =
  | { repaired: GeoJsonFeatureLike; failureReason: null }
  | { repaired: null; failureReason: SelfIntersectionRepairFailureReason };

export const selfIntersectionFindingKey = (
  finding: SelfIntersectionFinding,
): string =>
  `${finding.featureIndex}|${finding.geometryCollectionPath.join(".")}|` +
  `${finding.coordinatePath.join(".")}|${finding.relatedCoordinatePath.join(".")}`;

const segmentMatches = (
  ring: Position[],
  coordinatePath: number[],
  expected: [Position, Position],
): boolean => {
  const segmentIndex = coordinatePath.at(-1);
  return (
    segmentIndex !== undefined &&
    segmentIndex >= 0 &&
    segmentIndex + 1 < ring.length &&
    positionsEqual(ring[segmentIndex]!, expected[0]) &&
    positionsEqual(ring[segmentIndex + 1]!, expected[1])
  );
};

const normalizeSimpleExterior = (value: unknown): Position[] | null => {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    !value.every(
      (position) => isFinitePosition(position) && position.length === 2,
    ) ||
    !positionsEqual(value[0] as Position, value[value.length - 1] as Position)
  ) {
    return null;
  }
  const ring = value as Position[];
  const distinct = new Set(
    ring.slice(0, -1).map((position) => JSON.stringify(position)),
  );
  if (distinct.size < 3) return null;

  let orientation: RingOrientation;
  try {
    orientation = calculateRingOrientation(ring);
    if (
      orientation === "indeterminate" ||
      kinks(polygon([ring] as any)).features.length > 0
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return orientation === "counterclockwise"
    ? ring.map((position) => [...position])
    : [...ring].reverse().map((position) => [...position]);
};

const sourceVerticesArePreserved = (
  sourceRing: Position[],
  components: Position[][][],
): boolean => {
  const outputVertices = new Set(
    components.flatMap((component) =>
      component[0]!.map((position) => JSON.stringify(position)),
    ),
  );
  return sourceRing
    .slice(0, -1)
    .every((position) => outputVertices.has(JSON.stringify(position)));
};

const candidateIsValid = (feature: GeoJsonFeatureLike): boolean => {
  const candidateCollection: FeatureCollectionLike = {
    type: "FeatureCollection",
    features: [feature],
  };
  return (
    detectSelfIntersections(candidateCollection).findings.length === 0 &&
    detectMultipartIntegrity(candidateCollection).findings.length === 0
  );
};

const repairFeature = (
  feature: GeoJsonFeatureLike,
  finding: SelfIntersectionFinding,
): FeatureRepairAttempt => {
  const geometry = feature.geometry;
  if (
    finding.repairStrategy !== "UnkinkToMultiPolygon" ||
    (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") ||
    !Array.isArray(geometry.coordinates) ||
    finding.geometryCollectionPath.length > 0
  ) {
    return { repaired: null, failureReason: "UnsupportedGeometry" };
  }

  const componentIndex =
    geometry.type === "MultiPolygon" ? finding.polygonPath[0] : 0;
  const component =
    componentIndex === undefined
      ? undefined
      : geometry.type === "Polygon"
        ? geometry.coordinates
        : geometry.coordinates[componentIndex];
  if (
    componentIndex === undefined ||
    !Array.isArray(component) ||
    component.length !== 1 ||
    !Array.isArray(component[0])
  ) {
    return { repaired: null, failureReason: "UnsupportedGeometry" };
  }
  const ring = component[0] as Position[];
  if (
    !segmentMatches(ring, finding.coordinatePath, finding.firstSegment) ||
    !segmentMatches(
      ring,
      finding.relatedCoordinatePath,
      finding.secondSegment,
    )
  ) {
    return { repaired: null, failureReason: "StaleTarget" };
  }

  try {
    const source = polygon(
      [ring.map((position) => [...position])] as any,
      feature.properties ?? {},
    );
    const unkinked = unkinkPolygon(source);
    // One isolated proper crossing must resolve into exactly two bounded
    // faces. Accepting a single unchanged polygon would falsely claim repair;
    // more faces mean the detector and polygonizer disagree about complexity.
    if (unkinked.features.length !== 2) {
      return { repaired: null, failureReason: "PolygonizationFailed" };
    }

    const components: Position[][][] = [];
    for (const part of unkinked.features) {
      if (
        part.geometry.type !== "Polygon" ||
        part.geometry.coordinates.length !== 1
      ) {
        return { repaired: null, failureReason: "InvalidRepairOutput" };
      }
      const exterior = normalizeSimpleExterior(part.geometry.coordinates[0]);
      if (!exterior) {
        return { repaired: null, failureReason: "InvalidRepairOutput" };
      }
      components.push([exterior]);
    }
    if (!sourceVerticesArePreserved(ring, components)) {
      return { repaired: null, failureReason: "InvalidRepairOutput" };
    }

    const outputComponents =
      geometry.type === "Polygon"
        ? components
        : geometry.coordinates.flatMap((existing, index) =>
            index === componentIndex ? components : [existing],
          );

    const candidate: GeoJsonFeatureLike = {
      ...feature,
      geometry: {
        ...geometry,
        type: "MultiPolygon",
        coordinates: outputComponents,
      },
    };
    return candidateIsValid(candidate)
      ? { repaired: candidate, failureReason: null }
      : { repaired: null, failureReason: "InvalidRepairOutput" };
  } catch {
    return { repaired: null, failureReason: "PolygonizationFailed" };
  }
};

export const repairSelfIntersections = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: SelfIntersectionFinding[],
): SelfIntersectionRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return {
      geojson,
      repairedKeys: new Set(),
      failedReasons: new Map(),
    };
  }

  const candidateByFeature = new Map<number, SelfIntersectionFinding>();
  for (const finding of findings) {
    if (!finding.repairable || candidateByFeature.has(finding.featureIndex)) {
      continue;
    }
    candidateByFeature.set(finding.featureIndex, finding);
  }

  const repairedKeys = new Set<string>();
  const failedReasons = new Map<
    string,
    SelfIntersectionRepairFailureReason
  >();
  let changed = false;
  const features = geojson.features.map((feature, featureIndex) => {
    const finding = candidateByFeature.get(featureIndex);
    if (!finding) return feature;
    const attempt = repairFeature(feature, finding);
    if (!attempt.repaired) {
      failedReasons.set(
        selfIntersectionFindingKey(finding),
        attempt.failureReason,
      );
      return feature;
    }
    changed = true;
    repairedKeys.add(selfIntersectionFindingKey(finding));
    return attempt.repaired;
  });

  return {
    geojson: (changed ? { ...geojson, features } : geojson) as T,
    repairedKeys,
    failedReasons,
  };
};
