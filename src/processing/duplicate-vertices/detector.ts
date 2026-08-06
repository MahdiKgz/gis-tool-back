import {
  positionKey,
  positionsEqual,
} from "../shared/coordinates";
import { visitCoordinateSequences } from "./coordinate-sequences";
import {
  DuplicateVertexFinding,
  FeatureCollectionLike,
  Position,
  SequenceKind,
} from "./types";
import { getFeatureId } from "../shared/feature-id";

const isRequiredRingClosure = (
  coordinates: Position[],
  index: number,
): boolean =>
  index === coordinates.length - 1 &&
  coordinates.length > 1 &&
  positionsEqual(coordinates[0]!, coordinates[index]!);

const trailingClosureDuplicates = (
  coordinates: Position[],
  kind: SequenceKind,
): Set<number> => {
  const duplicates = new Set<number>();
  if (
    kind !== "ring" ||
    coordinates.length < 2 ||
    !positionsEqual(coordinates[0]!, coordinates[coordinates.length - 1]!)
  ) {
    return duplicates;
  }

  for (let index = coordinates.length - 2; index > 0; index--) {
    if (!positionsEqual(coordinates[index]!, coordinates[0]!)) break;
    duplicates.add(index);
  }
  return duplicates;
};

const collapsedCoordinates = (coordinates: Position[]): Position[] =>
  coordinates.filter(
    (position, index) =>
      index === 0 || !positionsEqual(position, coordinates[index - 1]!),
  );

const canSafelyCollapse = (
  coordinates: Position[],
  kind: SequenceKind,
): boolean => {
  const collapsed = collapsedCoordinates(coordinates);

  if (kind === "line") return collapsed.length >= 2;

  if (
    collapsed.length < 4 ||
    !positionsEqual(collapsed[0]!, collapsed[collapsed.length - 1]!)
  ) {
    return false;
  }

  const distinctVertices = new Set(
    collapsed.slice(0, -1).map(positionKey),
  ).size;
  return distinctVertices >= 3;
};

export const detectDuplicateVertices = (
  geojson: FeatureCollectionLike,
): DuplicateVertexFinding[] => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return [];
  }

  const findings: DuplicateVertexFinding[] = [];

  geojson.features.forEach((feature, featureIndex) => {
    visitCoordinateSequences(feature.geometry, (sequence) => {
      const lastSeen = new Map<string, number>();
      const safelyCollapsible = canSafelyCollapse(
        sequence.coordinates,
        sequence.kind,
      );
      const redundantClosures = trailingClosureDuplicates(
        sequence.coordinates,
        sequence.kind,
      );

      sequence.coordinates.forEach((position, coordinateIndex) => {
        if (
          sequence.kind === "ring" &&
          isRequiredRingClosure(sequence.coordinates, coordinateIndex)
        ) {
          return;
        }

        if (redundantClosures.has(coordinateIndex)) {
          findings.push({
            code: "DUPLICATE_VERTEX",
            featureIndex,
            featureId: getFeatureId(feature),
            geometryType: sequence.geometryType,
            geometryCollectionPath: [...sequence.geometryCollectionPath],
            coordinatePath: [
              ...sequence.coordinateRootPath,
              coordinateIndex,
            ],
            duplicateOfCoordinatePath: [
              ...sequence.coordinateRootPath,
              coordinateIndex + 1,
            ],
            kind: "consecutive",
            repairable: safelyCollapsible,
          });
          return;
        }

        const key = positionKey(position);
        const previousIndex = lastSeen.get(key);

        if (previousIndex !== undefined) {
          const consecutive = coordinateIndex === previousIndex + 1;
          findings.push({
            code: "DUPLICATE_VERTEX",
            featureIndex,
            featureId: getFeatureId(feature),
            geometryType: sequence.geometryType,
            geometryCollectionPath: [...sequence.geometryCollectionPath],
            coordinatePath: [
              ...sequence.coordinateRootPath,
              coordinateIndex,
            ],
            duplicateOfCoordinatePath: [
              ...sequence.coordinateRootPath,
              previousIndex,
            ],
            kind: consecutive ? "consecutive" : "non-consecutive",
            repairable: consecutive && safelyCollapsible,
          });
        }

        lastSeen.set(key, coordinateIndex);
      });
    });
  });

  return findings;
};
