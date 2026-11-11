import booleanIntersects from "@turf/boolean-intersects";
import { polygon as polygonFeature } from "@turf/helpers";
import RBush from "rbush";
import { AppError } from "../middlewares/errorHandler";
import { processInvalidHoles, ringBounds } from "../processing/invalid-holes";
import { detectInvalidRings } from "../processing/invalid-rings";
import { processMultipartIntegrity } from "../processing/multipart-integrity";
import { calculateRingOrientation, processRingOrientation } from "../processing/ring-orientation";
import { detectSelfIntersections } from "../processing/self-intersections";
import { getFeatureId } from "../processing/shared/feature-id";
import { isFinitePosition } from "../processing/shared/coordinates";
import { canonicalRingSignature } from "../processing/shared/ring-signature";
import type { FeatureCollectionLike, GeoJsonFeatureLike } from "../processing/shared/geojson";
import type { StoredAnalysis } from "./analysis-store.service";
import { readGisFile } from "./gis-file.service";
import { resolveHealedOutput } from "./heal-result.service";

export type ParcelGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface ConfirmedParcelEdit {
  geometry: ParcelGeometry;
  revision: string;
  legacyOutputIndex?: number;
}

export const isParcelType = (type: unknown): type is ParcelGeometry["type"] =>
  type === "Polygon" || type === "MultiPolygon";

const invalidGeometry = () =>
  new AppError(400, "The parcel must have valid, closed polygon rings", "INVALID_PARCEL_GEOMETRY");

export function validateParcelGeometry(value: unknown, type: ParcelGeometry["type"]): ParcelGeometry {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== type ||
    !("coordinates" in value) ||
    !Array.isArray(value.coordinates)
  )
    throw invalidGeometry();

  const polygons = type === "Polygon" ? [value.coordinates] : value.coordinates;
  if (!polygons.length) throw invalidGeometry();
  let dimension: number | undefined;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) throw invalidGeometry();
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) throw invalidGeometry();
      for (const position of ring) {
        if (
          !Array.isArray(position) ||
          position.length < 2 ||
          position.some(
            (coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate),
          ) ||
          Math.abs(position[0]) > 180 ||
          Math.abs(position[1]) > 90
        )
          throw invalidGeometry();
        dimension ??= position.length;
        if (position.length !== dimension) throw invalidGeometry();
      }
      if (
        ring[0].some((coordinate: number, index: number) => coordinate !== ring.at(-1)[index]) ||
        ring.some(
          (position, index) =>
            index > 0 && position[0] === ring[index - 1][0] && position[1] === ring[index - 1][1],
        ) ||
        calculateRingOrientation(ring) === "indeterminate"
      ) {
        throw invalidGeometry();
      }
    }
  }

  const geometry = { type, coordinates: value.coordinates } as ParcelGeometry;
  const collection = { type: "FeatureCollection", features: [{ type: "Feature", geometry }] };
  const invalidHoles = processInvalidHoles(collection, { tinyHoleAreaM2: 0 }, false).report;
  if (
    detectInvalidRings(collection).findings.length ||
    detectSelfIntersections(collection).findings.length ||
    processMultipartIntegrity(collection).report.invalidMultiPolygonsFound ||
    invalidHoles.issues.length ||
    polygons.some((polygon) => holesIntersect(polygon.slice(1)))
  ) {
    throw invalidGeometry();
  }
  const normalized = processRingOrientation(collection).geojson.features[0];
  return normalized?.geometry as ParcelGeometry;
}

function holesIntersect(holes: number[][][]) {
  const index = new RBush<ReturnType<typeof ringBounds> & { ring: ReturnType<typeof polygonFeature> }>();
  for (const hole of holes) {
    const bounds = ringBounds(hole);
    const ring = polygonFeature([hole]);
    if (index.search(bounds).some((candidate) => booleanIntersects(ring, candidate.ring))) return true;
    index.insert({ ...bounds, ring });
  }
  return false;
}

export function assertParcelReviewAvailable(analysis: StoredAnalysis) {
  if (analysis.healStatus === "queued" || analysis.healStatus === "processing") {
    throw new AppError(409, "Wait for automatic healing to finish", "PARCEL_HEALING_ACTIVE");
  }
}

export const parcelRevision = (analysis: StoredAnalysis, index: number) =>
  `${analysis.healStatus === "completed" ? analysis.healCompletedAt : "source"}:${analysis.parcelEdits?.[index]?.revision ?? "original"}`;

const unavailableParcel = () =>
  new AppError(409, "This parcel could not be identified in the healed output", "PARCEL_NOT_IN_OUTPUT");

function originalParcel(analysis: StoredAnalysis, index: number) {
  const feature = analysis.report.affectedFeatureCollection.features.find(
    (item) => item.snapgisFeatureIndex === index,
  );
  if (!feature || !isParcelType(feature.geometry?.type)) {
    throw new AppError(409, "The review issue does not identify a polygon parcel", "ISSUE_NOT_PARCEL");
  }
  return feature;
}

async function readCollection(
  filePath: string,
  fileName: string,
): Promise<FeatureCollectionLike & { features: GeoJsonFeatureLike[] }> {
  let data: unknown;
  try {
    data = await readGisFile(filePath, fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new AppError(410, "The result file is no longer available", "OUTPUT_FILE_EXPIRED");
  }
  const collection = data as FeatureCollectionLike;
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new AppError(422, "The file does not contain a feature collection", "INVALID_OUTPUT_GEOMETRY");
  }
  return { ...collection, features: collection.features };
}

async function readHealedCollection(analysis: StoredAnalysis) {
  const output = resolveHealedOutput(analysis);
  if (!output) throw unavailableParcel();
  return readCollection(output.filePath, "output.geojson");
}

function parcelSignature(geometry: GeoJsonFeatureLike["geometry"]) {
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return JSON.stringify(coordinates);
  const polygons = geometry?.type === "Polygon" ? [coordinates] : coordinates;
  if (
    !polygons.every(
      (polygon) =>
        Array.isArray(polygon) &&
        polygon.every((ring) => Array.isArray(ring) && ring.every(isFinitePosition)),
    )
  ) {
    return JSON.stringify(coordinates);
  }
  return JSON.stringify(
    polygons
      .map(([exterior, ...holes]) => [
        exterior ? canonicalRingSignature(exterior, 9) : null,
        holes.map((ring) => canonicalRingSignature(ring, 9)).sort(),
      ])
      .map((polygon) => JSON.stringify(polygon))
      .sort(),
  );
}

function findLegacyParcelIndex(
  source: GeoJsonFeatureLike[],
  feature: GeoJsonFeatureLike,
  features: GeoJsonFeatureLike[],
): number {
  const id = getFeatureId(feature);
  const geometry = parcelSignature(feature.geometry);
  const matchesShape = (candidate: GeoJsonFeatureLike) =>
    candidate?.geometry?.type === feature.geometry?.type &&
    parcelSignature(candidate.geometry) === geometry;
  const matches = features.flatMap((candidate, index) =>
    matchesShape(candidate) ? [{ index, id: getFeatureId(candidate) }] : [],
  );
  const sourceMatches = source.filter(matchesShape);
  if (id !== null) {
    const matchesWithId = matches.filter((candidate) => candidate.id === id);
    if (
      matchesWithId.length === 1 &&
      sourceMatches.filter((item) => getFeatureId(item) === id).length === 1
    ) {
      return matchesWithId[0]!.index;
    }
  }
  // Older outputs can omit the source ID. Only use a unique, unchanged footprint.
  const match = matches[0];
  if (
    !match ||
    matches.length !== 1 ||
    sourceMatches.length !== 1 ||
    (id !== null && match.id !== null && id !== match.id)
  )
    throw unavailableParcel();
  return match.index;
}

export const manualReviewGroupIds = (analysis: StoredAnalysis) =>
  new Set(
    analysis.report.issues
      .filter((issue) => issue.disposition === "ManualReview")
      .map((issue) => `${issue.check}:${issue.code}`),
  );

export function createParcelReviewReader(analysis: StoredAnalysis) {
  assertParcelReviewAvailable(analysis);
  const originals = new Map(
    analysis.report.affectedFeatureCollection.features.map((feature) => [
      feature.snapgisFeatureIndex,
      feature,
    ]),
  );
  let healed: ReturnType<typeof readHealedCollection> | undefined;
  let source: ReturnType<typeof readCollection> | undefined;
  return async (index: number) => {
    const feature = originals.get(index);
    if (!feature || !isParcelType(feature.geometry?.type)) {
      throw new AppError(409, "The review issue does not identify a polygon parcel", "ISSUE_NOT_PARCEL");
    }
    const revision = parcelRevision(analysis, index);
    const saved = analysis.parcelEdits?.[index];
    const result = {
      featureIndex: index,
      featureId: getFeatureId(feature),
      revision,
      confirmed: Boolean(saved),
    };
    if (analysis.healStatus !== "completed")
      return {
        ...result,
        geometry: saved?.geometry ?? feature.geometry,
        outputIndex: index,
        legacyOutputIndex: undefined,
      };

    const { features } = await (healed ??= readHealedCollection(analysis));
    const outputIndex = analysis.healResult?.manualParcelOutputIndexes?.[index];
    if (outputIndex !== undefined) {
      const geometry = features[outputIndex]?.geometry;
      if (!isParcelType(geometry?.type)) throw unavailableParcel();
      return {
        ...result,
        geometry: saved?.geometry ?? geometry,
        outputIndex,
        legacyOutputIndex: undefined,
      };
    }
    const legacyOutputIndex =
      saved?.legacyOutputIndex ??
      findLegacyParcelIndex(
        (await (source ??= readCollection(analysis.jobData.filePath, analysis.jobData.originalName)))
          .features,
        feature,
        features,
      );
    const geometry = features[legacyOutputIndex]?.geometry;
    if (!isParcelType(geometry?.type)) throw unavailableParcel();
    return {
      ...result,
      geometry: saved?.geometry ?? geometry,
      outputIndex: legacyOutputIndex,
      legacyOutputIndex,
    };
  };
}

export const getParcelForReview = (analysis: StoredAnalysis, index: number) =>
  createParcelReviewReader(analysis)(index);

export const hasManualParcelEdits = (analysis: StoredAnalysis) =>
  Object.keys(analysis.parcelEdits ?? {}).length > 0;

export const manualParcelFileName = (analysis: StoredAnalysis) =>
  resolveHealedOutput(analysis)?.fileName ?? `reviewed-${analysis.id}.geojson`;

export async function buildReviewedOutput(analysis: StoredAnalysis) {
  const completed = analysis.healStatus === "completed";
  const data = completed
    ? await readHealedCollection(analysis)
    : await readCollection(analysis.jobData.filePath, analysis.jobData.originalName);
  const mapping = analysis.healResult?.manualParcelOutputIndexes;
  const edits = Object.entries(analysis.parcelEdits ?? {});
  const legacySource =
    completed &&
    edits.some(
      ([index, edit]) => mapping?.[Number(index)] === undefined && edit.legacyOutputIndex === undefined,
    )
      ? (await readCollection(analysis.jobData.filePath, analysis.jobData.originalName)).features
      : undefined;
  delete data.bbox;
  const replacements = new Map<number, ConfirmedParcelEdit>();
  for (const [key, edit] of edits) {
    const sourceIndex = Number(key);
    const index = completed
      ? (mapping?.[sourceIndex] ??
        edit.legacyOutputIndex ??
        (legacySource &&
          findLegacyParcelIndex(legacySource, originalParcel(analysis, sourceIndex), data.features)))
      : sourceIndex;
    if (index === undefined || !data.features[index] || replacements.has(index))
      throw unavailableParcel();
    replacements.set(index, edit);
  }
  for (const [index, edit] of replacements) {
    const { bbox: _bbox, ...properties } = data.features[index]!;
    data.features[index] = { ...properties, geometry: edit.geometry };
  }
  return data;
}
