import area from "@turf/area";
import kinks from "@turf/kinks";
import { polygon } from "@turf/helpers";
import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import { ringPathKey } from "../shared/ring-path";
import { canonicalRingSignature } from "../shared/ring-signature";
import { visitHoleCandidates } from "./hole-candidates";
import {
  boundsContain,
  classifyRingContainment,
  ringBounds,
  RingBounds,
} from "./spatial";
import {
  FeatureCollectionLike,
  HoleCandidate,
  InvalidHoleDetectionResult,
  InvalidHoleFinding,
  InvalidHoleOptions,
  InvalidHoleType,
} from "./types";

export const DEFAULT_TINY_HOLE_AREA_M2 = 0.01;

interface HoleRecord {
  key: string;
  featureIndex: number;
  featureId: string | number | null;
  candidate: HoleCandidate;
  areaM2: number | null;
  exteriorAreaM2: number;
  bounds: RingBounds;
  signature: string;
  selfIntersecting: boolean;
}

interface IndexedHole extends RingBounds {
  index: number;
}

const polygonGroupKey = (
  featureIndex: number,
  candidate: HoleCandidate,
): string =>
  `${featureIndex}|${candidate.geometryCollectionPath.join(
    ".",
  )}|${candidate.polygonPath.join(".")}`;

const ringIsSelfIntersecting = (ring: number[][]): boolean => {
  try {
    return kinks(polygon([ring] as any)).features.length > 0;
  } catch {
    return true;
  }
};

const ringAreaM2 = (ring: number[][]): number | null => {
  try {
    const measured = area(polygon([ring] as any));
    return Number.isFinite(measured) ? measured : null;
  } catch {
    return null;
  }
};

const findingCode = (
  type: InvalidHoleType,
): InvalidHoleFinding["code"] => {
  switch (type) {
    case "outside":
      return "HOLE_OUTSIDE_POLYGON";
    case "nested":
      return "NESTED_HOLE";
    case "duplicate":
      return "DUPLICATE_HOLE";
    case "self-intersecting":
      return "SELF_INTERSECTING_HOLE";
    case "touching-boundary":
      return "HOLE_TOUCHING_BOUNDARY";
    case "tiny":
      return "TINY_HOLE";
    case "larger-than-polygon":
      return "HOLE_LARGER_THAN_POLYGON";
  }
};

const createFinding = (
  type: InvalidHoleType,
  featureIndex: number,
  featureId: string | number | null,
  record: HoleRecord,
  relatedHoleCoordinatePath: number[] | null = null,
): InvalidHoleFinding => {
  const repairable = type === "outside" || type === "tiny";
  return {
    code: findingCode(type),
    type,
    featureIndex,
    featureId,
    geometryType: record.candidate.geometryType,
    geometryCollectionPath: [
      ...record.candidate.geometryCollectionPath,
    ],
    polygonPath: [...record.candidate.polygonPath],
    coordinatePath: [...record.candidate.coordinatePath],
    relatedHoleCoordinatePath: relatedHoleCoordinatePath
      ? [...relatedHoleCoordinatePath]
      : null,
    holeSignature: record.signature,
    holeAreaM2: record.areaM2,
    exteriorAreaM2: record.exteriorAreaM2,
    repairable,
    recommendedRepair: repairable ? "Remove" : "ManualReview",
  };
};

const buildHoleRecords = (
  geojson: FeatureCollectionLike,
): {
  holesScanned: number;
  recordsByPolygon: Map<string, HoleRecord[]>;
} => {
  const recordsByPolygon = new Map<string, HoleRecord[]>();
  const exteriorAreaByPolygon = new Map<string, number>();
  let holesScanned = 0;

  geojson.features!.forEach((feature, featureIndex) => {
    visitHoleCandidates(feature.geometry, (candidate) => {
      holesScanned++;
      const groupKey = polygonGroupKey(featureIndex, candidate);
      let exteriorAreaM2 = exteriorAreaByPolygon.get(groupKey);
      if (exteriorAreaM2 === undefined) {
        exteriorAreaM2 =
          ringAreaM2(candidate.exteriorRing) ?? 0;
        exteriorAreaByPolygon.set(groupKey, exteriorAreaM2);
      }
      const selfIntersecting = ringIsSelfIntersecting(candidate.ring);
      const record: HoleRecord = {
        key: ringPathKey(
          featureIndex,
          candidate.geometryCollectionPath,
          candidate.coordinatePath,
        ),
        featureIndex,
        featureId: getFeatureId(feature),
        candidate,
        areaM2: selfIntersecting ? null : ringAreaM2(candidate.ring),
        exteriorAreaM2,
        bounds: ringBounds(candidate.ring),
        signature: canonicalRingSignature(candidate.ring),
        selfIntersecting,
      };
      const records = recordsByPolygon.get(groupKey) ?? [];
      records.push(record);
      recordsByPolygon.set(groupKey, records);
    });
  });

  return { holesScanned, recordsByPolygon };
};

export const detectInvalidHoles = (
  geojson: FeatureCollectionLike,
  options: InvalidHoleOptions = {
    tinyHoleAreaM2: DEFAULT_TINY_HOLE_AREA_M2,
  },
): InvalidHoleDetectionResult => {
  if (
    !Number.isFinite(options.tinyHoleAreaM2) ||
    options.tinyHoleAreaM2 < 0
  ) {
    throw new RangeError("tinyHoleAreaM2 must be a finite non-negative number");
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { holesScanned: 0, findings: [] };
  }

  const { holesScanned, recordsByPolygon } = buildHoleRecords(geojson);
  const findings: InvalidHoleFinding[] = [];

  for (const records of recordsByPolygon.values()) {
    if (records.length === 0) continue;
    const featureIndex = records[0]!.featureIndex;
    const featureId = records[0]!.featureId;
    const firstBySignature = new Map<string, HoleRecord>();
    const duplicateKeys = new Set<string>();
    const strictlyContainedKeys = new Set<string>();

    for (const record of records) {
      if (record.selfIntersecting) {
        findings.push(
          createFinding("self-intersecting", featureIndex, featureId, record),
        );
        continue;
      }

      const containment = classifyRingContainment(
        record.candidate.ring,
        record.candidate.exteriorRing,
      );
      if (containment.outside) {
        findings.push(
          createFinding("outside", featureIndex, featureId, record),
        );
      } else if (containment.touching) {
        findings.push(
          createFinding("touching-boundary", featureIndex, featureId, record),
        );
      } else {
        strictlyContainedKeys.add(record.key);
      }

      if (
        record.areaM2 !== null &&
        record.areaM2 < options.tinyHoleAreaM2
      ) {
        findings.push(createFinding("tiny", featureIndex, featureId, record));
      }
      if (
        record.areaM2 !== null &&
        record.areaM2 > record.exteriorAreaM2
      ) {
        findings.push(
          createFinding(
            "larger-than-polygon",
            featureIndex,
            featureId,
            record,
          ),
        );
      }

      const firstMatch = firstBySignature.get(record.signature);
      if (firstMatch) {
        duplicateKeys.add(record.key);
        duplicateKeys.add(firstMatch.key);
        findings.push(
          createFinding(
            "duplicate",
            featureIndex,
            featureId,
            record,
            firstMatch.candidate.coordinatePath,
          ),
        );
      } else {
        firstBySignature.set(record.signature, record);
      }
    }

    if (records.length < 2) continue;

    const index = new RBush<IndexedHole>();
    index.load(
      records.map((record, recordIndex) => ({
        ...record.bounds,
        index: recordIndex,
      })),
    );
    const nestedParent = new Map<
      string,
      {
        inner: HoleRecord;
        parent: HoleRecord;
        parentAreaM2: number;
      }
    >();

    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const first = records[recordIndex]!;
      if (
        first.selfIntersecting ||
        duplicateKeys.has(first.key) ||
        !strictlyContainedKeys.has(first.key)
      )
        continue;

      for (const candidate of index.search(first.bounds)) {
        if (candidate.index <= recordIndex) continue;
        const second = records[candidate.index]!;
        if (
          second.selfIntersecting ||
          duplicateKeys.has(second.key) ||
          !strictlyContainedKeys.has(second.key)
        )
          continue;

        let inner: HoleRecord | null = null;
        let outer: HoleRecord | null = null;
        if (boundsContain(first.bounds, second.bounds)) {
          inner = second;
          outer = first;
        } else if (boundsContain(second.bounds, first.bounds)) {
          inner = first;
          outer = second;
        }
        if (!inner || !outer) continue;

        const containment = classifyRingContainment(
          inner.candidate.ring,
          outer.candidate.ring,
        );
        if (!containment.strictlyInside) continue;

        const parentAreaM2 =
          outer.areaM2 ?? Number.POSITIVE_INFINITY;
        const existing = nestedParent.get(inner.key);
        if (!existing || parentAreaM2 < existing.parentAreaM2) {
          nestedParent.set(inner.key, {
            inner,
            parent: outer,
            parentAreaM2,
          });
        }
      }
    }

    for (const relationship of nestedParent.values()) {
      findings.push(
        createFinding(
          "nested",
          featureIndex,
          featureId,
          relationship.inner,
          relationship.parent.candidate.coordinatePath,
        ),
      );
    }
  }

  return { holesScanned, findings };
};
