import { Position, positionKey } from "../shared/coordinates";
import { getFeatureId } from "../shared/feature-id";
import { visitGeometryPositions } from "../shared/geometry-positions";
import {
  CoordinatePrecisionDetectionResult,
  CoordinatePrecisionOptions,
  FeatureCollectionLike,
} from "./types";

export const DEFAULT_MAX_DECIMAL_PLACES = 9;
const MAX_SUPPORTED_DECIMAL_PLACES = 15;

const decimalPlaces = (value: number): number => {
  const [coefficient, exponentText] = value
    .toString()
    .toLowerCase()
    .split("e");
  const coefficientPlaces = coefficient!.split(".")[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, coefficientPlaces - exponent);
};

const roundedNumber = (value: number, places: number): number => {
  const rounded = Number(value.toFixed(places));
  return Object.is(rounded, -0) ? 0 : rounded;
};

const sequenceParentLength: Record<string, number | undefined> = {
  MultiPoint: 0,
  LineString: 0,
  MultiLineString: 1,
  Polygon: 1,
  MultiPolygon: 2,
};

interface SeenRoundedPosition {
  exactKey: string;
  coordinatePath: number[];
}

export const detectCoordinatePrecision = (
  geojson: FeatureCollectionLike,
  options: CoordinatePrecisionOptions = {
    maxDecimalPlaces: DEFAULT_MAX_DECIMAL_PLACES,
  },
): CoordinatePrecisionDetectionResult => {
  if (
    !Number.isInteger(options.maxDecimalPlaces) ||
    options.maxDecimalPlaces < 0 ||
    options.maxDecimalPlaces > MAX_SUPPORTED_DECIMAL_PLACES
  ) {
    throw new RangeError(
      `maxDecimalPlaces must be an integer between 0 and ` +
        `${MAX_SUPPORTED_DECIMAL_PLACES}`,
    );
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { positionsScanned: 0, findings: [] };
  }

  const scale = 10 ** options.maxDecimalPlaces;
  const safeMagnitude = Number.MAX_SAFE_INTEGER / scale;
  const roundedPositionsBySequence = new Map<
    string,
    Map<string, SeenRoundedPosition>
  >();
  let positionsScanned = 0;
  const findings: CoordinatePrecisionDetectionResult["findings"] = [];

  geojson.features.forEach((feature, featureIndex) => {
    visitGeometryPositions(feature.geometry, (candidate) => {
      if (
        !Array.isArray(candidate.value) ||
        candidate.value.length < 2 ||
        !candidate.value.every(
          (ordinate) =>
            typeof ordinate === "number" && Number.isFinite(ordinate),
        )
      ) {
        return;
      }
      positionsScanned++;
      const position = candidate.value as Position;
      const base = {
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: candidate.geometryType,
        geometryCollectionPath: [...candidate.geometryCollectionPath],
        coordinatePath: [...candidate.coordinatePath],
        relatedCoordinatePath: null,
        maxDecimalPlaces: options.maxDecimalPlaces,
        repairable: false as const,
      };

      position.forEach((value, ordinateIndex) => {
        const roundedValue = roundedNumber(
          value,
          options.maxDecimalPlaces,
        );
        const actualDecimalPlaces = decimalPlaces(value);
        if (roundedValue !== value) {
          findings.push({
            ...base,
            code: "EXCESSIVE_COORDINATE_PRECISION",
            ordinateIndex,
            value,
            roundedValue,
            decimalPlaces: actualDecimalPlaces,
          });
        }
        if (Math.abs(roundedValue) > safeMagnitude) {
          findings.push({
            ...base,
            code: "UNSAFE_COORDINATE_MAGNITUDE",
            ordinateIndex,
            value,
            roundedValue,
            decimalPlaces: actualDecimalPlaces,
          });
        }
      });

      const parentLength = sequenceParentLength[candidate.geometryType];
      if (parentLength === undefined) return;
      const sequencePath = candidate.coordinatePath.slice(0, parentLength);
      const sequenceKey =
        `${featureIndex}|${candidate.geometryCollectionPath.join(".")}|` +
        `${candidate.geometryType}|${sequencePath.join(".")}`;
      const seen =
        roundedPositionsBySequence.get(sequenceKey) ??
        new Map<string, SeenRoundedPosition>();
      const exactKey = positionKey(position.slice(0, 2));
      const roundedKey = positionKey([
        roundedNumber(position[0]!, options.maxDecimalPlaces),
        roundedNumber(position[1]!, options.maxDecimalPlaces),
      ]);
      const previous = seen.get(roundedKey);
      if (previous && previous.exactKey !== exactKey) {
        findings.push({
          ...base,
          code: "ROUNDING_COLLISION",
          relatedCoordinatePath: [...previous.coordinatePath],
          ordinateIndex: null,
          value: null,
          roundedValue: null,
          decimalPlaces: null,
        });
      } else if (!previous) {
        seen.set(roundedKey, {
          exactKey,
          coordinatePath: [...candidate.coordinatePath],
        });
        roundedPositionsBySequence.set(sequenceKey, seen);
      }
    });
  });

  return { positionsScanned, findings };
};
