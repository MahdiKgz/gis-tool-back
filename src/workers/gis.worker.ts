// @ts-nocheck
import { Worker, Job, Queue } from "bullmq";
import { redisConnection } from "../services/queue.service";
import path from "path";
import fs from "fs";

// --- Turf.js Modules ---
import truncate from "@turf/truncate";
import kinks from "@turf/kinks";
import unkinkPolygon from "@turf/unkink-polygon";
import distance from "@turf/distance";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import lineIntersect from "@turf/line-intersect";
import booleanIntersects from "@turf/boolean-intersects";
import lineSlice from "@turf/line-slice";
import { point, featureCollection } from "@turf/helpers";
import area from "@turf/area";
import bbox from "@turf/bbox";
import intersect from "@turf/intersect";
import union from "@turf/union";

// --- Spatial Index ---
import RBush from "rbush";

// --- Parsers ---
import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";
import { processDuplicateVertices } from "../processing/duplicate-vertices";
import { processInvalidHoles } from "../processing/invalid-holes";
import { processInvalidRings } from "../processing/invalid-rings";
import {
  buildRingClosureReport,
  detectOpenRings,
} from "../processing/ring-closure";
import { processRingOrientation } from "../processing/ring-orientation";
import { canonicalRingSignature } from "../processing/shared/ring-signature";
const mapshaper = require("mapshaper");

// ---------------------------------------------------------------------------
// Job data interface
// ---------------------------------------------------------------------------
interface GisJobData {
  fileName: string;
  originalName: string;
  filePath: string;
  size: number;
  tolerance?: number;
  overlapThresholdRatio?: number;
  // [DUPLICATE DETECTION] Max boundary offset (metres) for a pair of
  // near-identical polygons to be flagged as a Near Duplicate. Independent
  // of snap tolerance — a duplicate-detection decision, not a healing one.
  nearDuplicateMaxOffsetMeters?: number;
  // Minimum intersection-over-union shape similarity required before a
  // pair is even considered for near-duplicate classification. Guards
  // against flagging two genuinely different, merely nearby, parcels.
  nearDuplicateMinIoU?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MIN_SLIVER_MULTIPLIER = 10;
const GAP_SNAP_MULTIPLIER = 3;
const DEFAULT_OVERLAP_THRESHOLD = 0.05;

// Sub-epsilon area guard for @turf/intersect artefacts produced when two
// polygons share an exact edge (e.g. right after a merge). 1e-8 m² is well
// below any real cadastral overlap but comfortably above floating-point
// noise, which typically lands around 1e-10 to 1e-13 m².
// A previous version of this file used 1e-10 — too tight, it let those
// noise artefacts through as "tiny real overlaps" and triggered false merges.
const FLOAT_EDGE_EPSILON = 1e-8;

// Overlap resolution runs in passes because a merge can grow a polygon large
// enough to newly overlap a THIRD polygon that wasn't near either original
// piece. Each pass rebuilds the spatial index from scratch so bboxes are
// always current. Capped to avoid runaway iteration on pathological input.
const MAX_OVERLAP_PASSES = 6;

// ---------------------------------------------------------------------------
// [DUPLICATE DETECTION] Constants
// ---------------------------------------------------------------------------
// Tolerance for "identical" bbox/coordinate comparisons — this exists purely
// to absorb floating-point serialization noise (e.g. a value written as
// 51.39000000000001 vs 51.39), NOT to represent any real-world distance.
// ~1e-9 degrees is sub-millimetre at any latitude.
const EXACT_MATCH_EPSILON_DEG = 1e-9;

// Default near-duplicate gates. Both are independent of snap tolerance —
// same design principle as overlapThresholdRatio: duplicate severity and
// topology-healing tolerance measure different things and must not share
// a single knob.
const DEFAULT_NEAR_DUPLICATE_MAX_OFFSET_M = 0.01; // 1cm
const DEFAULT_NEAR_DUPLICATE_MIN_IOU = 0.9;

// RBush candidate search for near-duplicates expands the query box by this
// multiple of the offset tolerance, mirroring the GAP_SNAP_MULTIPLIER
// precedent — guards against missing a near-duplicate whose bbox sits just
// past a tightly-drawn query window.
const NEAR_DUPLICATE_SEARCH_MARGIN_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const computeMinSliverAreaM2 = (toleranceMeters: number): number =>
  Math.pow(toleranceMeters * MIN_SLIVER_MULTIPLIER, 2);

const countSlivers = (features: any[], minAreaM2: number): number =>
  features.filter((f) => {
    try {
      return area(f) < minAreaM2;
    } catch {
      return false;
    }
  }).length;

const buildIndex = (features: any[]): RBush<any> => {
  const index = new RBush<any>();
  index.load(
    features.map((f, idx) => {
      const [minX, minY, maxX, maxY] = bbox(f);
      return { minX, minY, maxX, maxY, idx };
    }),
  );
  return index;
};

// ---------------------------------------------------------------------------
// [DUPLICATE DETECTION] Polygon Duplicate Detection Engine
//
// Runs immediately after polygon features are loaded, BEFORE overlap
// detection. Duplicates are a distinct data-quality problem from overlaps —
// two identical parcels are not "two parcels overlapping", they are the same
// parcel present twice, almost always from a double import or a merge of two
// source files that both contained the same feature. Feeding a pair of exact
// duplicates into the overlap engine would make them look like a 100%
// critical overlap, which is the wrong diagnosis and the wrong fix.
//
// THREE LEVELS, THREE DIFFERENT COMPARISON STRATEGIES:
//
// Level 1 — Exact Duplicate
//   Same ring count, same vertex count per ring, same coordinates in the
//   SAME ORDER. This is a direct coordinate-array comparison — cheapest and
//   most literal interpretation of "identical". Auto-removed (this is the
//   only level allowed to auto-repair).
//
// Level 2 — Topological Duplicate
//   Same shape, but vertex order may be rotated and/or reversed (different
//   starting vertex, or opposite winding direction). A polygon [1,2,3,4] and
//   [3,4,1,2] are the same ring. Detected with a canonical signature that
//   uses Booth's algorithm to find the least cyclic rotation in both winding
//   directions in O(n), avoiding quadratic rotation scans.
//   Reported only — never auto-removed.
//
// Level 3 — Near Duplicate
//   Same general shape, differs by a small boundary offset (a few mm to a
//   few cm — re-digitizing drift, coordinate rounding from a different
//   source system, etc). Two independent gates must both pass:
//     - IoU (intersection-over-union) >= nearDuplicateMinIoU — guards
//       against flagging two genuinely different, merely adjacent parcels.
//     - estimated offsetMeters <= nearDuplicateMaxOffsetMeters
//   offsetMeters is an ESTIMATE, not an exact Hausdorff distance: the
//   symmetric-difference area (the sliver of non-overlapping area between
//   the two shapes) is divided by the average perimeter of the two
//   polygons. For two near-identical shapes the non-overlapping area forms
//   a thin ring around the boundary, and area ≈ perimeter × average width,
//   so width ≈ area / perimeter. This is a standard, defensible
//   approximation — not exact, but accurate enough to rank severity and to
//   decide whether a pair falls inside a millimetre/centimetre tolerance.
//   Reported only — never auto-removed.
//
// PERFORMANCE:
//   A single RBush index is built once (unlike the overlap engine, this
//   stage never mutates geometry mid-scan, so there is no staleness risk
//   requiring a multi-pass rebuild — removing an exact duplicate doesn't
//   change any other feature's bbox). Per-feature area and canonical ring
//   signatures are cached on first computation.
// ---------------------------------------------------------------------------
interface DuplicateEntry {
  type: "exact" | "topological" | "near";
  featureIndexA: number;
  featureIndexB: number;
  featureIdA: string | null;
  featureIdB: string | null;
  confidence: number;
  duplicateType: "Exact" | "Topological" | "Near";
  offsetMeters?: number;
  status: "Duplicate";
  recommendedAction: "Delete" | "ManualReview";
}

const ringsExactlyEqual = (ringA: number[][], ringB: number[][]): boolean => {
  if (ringA.length !== ringB.length) return false;
  for (let i = 0; i < ringA.length; i++) {
    if (
      Math.abs(ringA[i][0] - ringB[i][0]) > EXACT_MATCH_EPSILON_DEG ||
      Math.abs(ringA[i][1] - ringB[i][1]) > EXACT_MATCH_EPSILON_DEG
    )
      return false;
  }
  return true;
};

const getRings = (f: any): number[][][] =>
  f.geometry.type === "Polygon"
    ? f.geometry.coordinates
    : f.geometry.coordinates.flat();

const geometryExactlyEqual = (
  ringsA: number[][][],
  ringsB: number[][][],
): boolean => {
  if (ringsA.length !== ringsB.length) return false;
  for (let i = 0; i < ringsA.length; i++) {
    if (!ringsExactlyEqual(ringsA[i], ringsB[i])) return false;
  }
  return true;
};

// Reuses distance() + point(), already imported — avoids adding @turf/length
// as a new dependency purely for this one estimate.
const ringPerimeterKm = (ring: number[][]): number => {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    total += distance(point(ring[i]), point(ring[i + 1]), {
      units: "kilometers",
    });
  }
  return total;
};

const polygonPerimeterKm = (f: any): number =>
  getRings(f).reduce((sum, ring) => sum + ringPerimeterKm(ring), 0);

const detectDuplicatePolygons = (
  features: any[],
  options: {
    nearDuplicateMaxOffsetMeters: number;
    nearDuplicateMinIoU: number;
  },
): {
  features: any[];
  duplicatesFound: number;
  exactDuplicates: number;
  topologicalDuplicates: number;
  nearDuplicates: number;
  duplicateErrorLog: DuplicateEntry[];
} => {
  const duplicateErrorLog: DuplicateEntry[] = [];
  let exactDuplicates = 0;
  let topologicalDuplicates = 0;
  let nearDuplicates = 0;

  if (features.length < 2) {
    return {
      features,
      duplicatesFound: 0,
      exactDuplicates,
      topologicalDuplicates,
      nearDuplicates,
      duplicateErrorLog,
    };
  }

  // Single build — this stage never mutates geometry mid-scan, so unlike
  // the overlap engine there is no staleness risk requiring a rebuild.
  const index = buildIndex(features);
  const removed = new Set<number>();

  const nearOffsetDeg = options.nearDuplicateMaxOffsetMeters / 111320;
  const searchMarginDeg =
    nearOffsetDeg * NEAR_DUPLICATE_SEARCH_MARGIN_MULTIPLIER;

  // Per-feature caches — computed once, reused across every candidate pair
  // that touches this feature, instead of recomputing on every comparison.
  const areaCache = new Map<number, number>();
  const signatureCache = new Map<number, string[]>();

  const getArea = (idx: number, f: any): number => {
    if (!areaCache.has(idx)) {
      try {
        areaCache.set(idx, area(f));
      } catch {
        areaCache.set(idx, -1);
      }
    }
    return areaCache.get(idx)!;
  };

  const getRingSignatures = (idx: number, f: any): string[] => {
    if (!signatureCache.has(idx)) {
      signatureCache.set(
        idx,
        getRings(f).map((ring) => canonicalRingSignature(ring, 9)),
      );
    }
    return signatureCache.get(idx)!;
  };

  for (let i = 0; i < features.length; i++) {
    if (removed.has(i)) continue;

    const featureA = features[i];
    const [minX, minY, maxX, maxY] = bbox(featureA);

    const candidates = index.search({
      minX: minX - searchMarginDeg,
      minY: minY - searchMarginDeg,
      maxX: maxX + searchMarginDeg,
      maxY: maxY + searchMarginDeg,
    });

    for (const item of candidates) {
      const j = item.idx;
      if (j <= i || removed.has(j)) continue;

      const featureB = features[j];
      const areaA = getArea(i, featureA);
      const areaB = getArea(j, featureB);
      if (areaA <= 0 || areaB <= 0) continue;

      const [bMinX, bMinY, bMaxX, bMaxY] = bbox(featureB);
      const bboxDeltaDeg = Math.max(
        Math.abs(minX - bMinX),
        Math.abs(minY - bMinY),
        Math.abs(maxX - bMaxX),
        Math.abs(maxY - bMaxY),
      );
      const areaRelDiff = Math.abs(areaA - areaB) / Math.max(areaA, areaB);

      const featureIdA = featureA.id ?? featureA.properties?.id ?? null;
      const featureIdB = featureB.id ?? featureB.properties?.id ?? null;

      // ── Gate 1: candidate for EXACT or TOPOLOGICAL — bbox/area must be
      // essentially identical, since both levels represent the literal same
      // shape (order/direction aside), which mathematically guarantees
      // identical bbox and area. ──────────────────────────────────────────
      if (bboxDeltaDeg <= EXACT_MATCH_EPSILON_DEG && areaRelDiff <= 1e-9) {
        const ringsA = getRings(featureA);
        const ringsB = getRings(featureB);

        if (ringsA.length === ringsB.length) {
          if (geometryExactlyEqual(ringsA, ringsB)) {
            // Level 1 — Exact Duplicate. Only level that auto-removes.
            removed.add(j);
            exactDuplicates++;
            duplicateErrorLog.push({
              type: "exact",
              featureIndexA: i,
              featureIndexB: j,
              featureIdA,
              featureIdB,
              confidence: 1.0,
              duplicateType: "Exact",
              status: "Duplicate",
              recommendedAction: "Delete",
            });
            continue;
          }

          const signaturesA = getRingSignatures(i, featureA);
          const signaturesB = getRingSignatures(j, featureB);
          const signaturesMatch =
            signaturesA.length === signaturesB.length &&
            signaturesA.every(
              (signature, ringIndex) =>
                signature === signaturesB[ringIndex],
            );

          if (signaturesMatch) {
            // Level 2 — Topological Duplicate. Report only, never remove.
            topologicalDuplicates++;
            duplicateErrorLog.push({
              type: "topological",
              featureIndexA: i,
              featureIndexB: j,
              featureIdA,
              featureIdB,
              confidence: 0.99,
              duplicateType: "Topological",
              status: "Duplicate",
              recommendedAction: "ManualReview",
            });
            continue;
          }
        }
      }

      // ── Gate 2: candidate for NEAR duplicate — small offset, high shape
      // similarity. Independent of Gate 1; a pair can fail Gate 1 (bbox
      // differs slightly) and still legitimately be a near-duplicate. ────
      if (bboxDeltaDeg <= searchMarginDeg) {
        let intersectGeom: any;
        try {
          intersectGeom = intersect(featureCollection([featureA, featureB]));
        } catch {
          continue;
        }
        if (!intersectGeom) continue;

        let unionGeom: any;
        try {
          unionGeom = union(featureCollection([featureA, featureB]));
        } catch {
          continue;
        }
        if (!unionGeom) continue;

        let intersectionAreaM2: number, unionAreaM2: number;
        try {
          intersectionAreaM2 = area(intersectGeom);
          unionAreaM2 = area(unionGeom);
        } catch {
          continue;
        }
        if (unionAreaM2 <= 0) continue;

        const iou = intersectionAreaM2 / unionAreaM2;
        // Not similar enough — likely a genuine distinct-but-nearby parcel,
        // leave it for the overlap engine rather than misclassifying here.
        if (iou < options.nearDuplicateMinIoU) continue;

        const symDiffAreaM2 = unionAreaM2 - intersectionAreaM2;
        const avgPerimeterM =
          ((polygonPerimeterKm(featureA) + polygonPerimeterKm(featureB)) / 2) *
          1000;
        const offsetMeters =
          avgPerimeterM > 0 ? symDiffAreaM2 / avgPerimeterM : 0;

        if (offsetMeters > options.nearDuplicateMaxOffsetMeters) continue;

        nearDuplicates++;
        duplicateErrorLog.push({
          type: "near",
          featureIndexA: i,
          featureIndexB: j,
          featureIdA,
          featureIdB,
          confidence: Math.round(iou * 100) / 100,
          duplicateType: "Near",
          offsetMeters: Math.round(offsetMeters * 1000) / 1000,
          status: "Duplicate",
          recommendedAction: "ManualReview",
        });
      }
    }
  }

  return {
    features: features.filter((_, idx) => !removed.has(idx)),
    duplicatesFound: exactDuplicates + topologicalDuplicates + nearDuplicates,
    exactDuplicates,
    topologicalDuplicates,
    nearDuplicates,
    duplicateErrorLog,
  };
};

// ---------------------------------------------------------------------------
// Mapshaper two-pass pipeline
// ---------------------------------------------------------------------------
const runMapshaperPipeline = async (
  geojson: any,
  toleranceMeters: number,
): Promise<{
  result: any;
  sliversRemovedCount: number;
  gapsFound: number;
  gapsClosed: number;
}> =>
  new Promise((resolve, reject) => {
    const intervalDeg = toleranceMeters / 111320;
    const minAreaM2 = computeMinSliverAreaM2(toleranceMeters);

    const sliversBefore = countSlivers(geojson.features, minAreaM2);
    const gapsFound = scanGaps(geojson.features, toleranceMeters);

    const commands = [
      `-i input.json`,
      `-snap interval=${intervalDeg}`,
      `-clean`,
      `-filter '$.area > ${minAreaM2}' remove-empty`,
      `-snap interval=${intervalDeg * GAP_SNAP_MULTIPLIER}`,
      `-clean`,
      `-o output.json format=geojson`,
    ].join(" ");

    mapshaper.applyCommands(
      commands,
      { "input.json": JSON.stringify(geojson) },
      (err: any, output: any) => {
        if (err) return reject(err);
        if (!output?.["output.json"])
          return reject(new Error("Mapshaper output missing"));

        const result = JSON.parse(output["output.json"].toString("utf-8"));
        const sliversAfter = countSlivers(result.features, minAreaM2);
        const sliversRemovedCount = Math.max(0, sliversBefore - sliversAfter);
        const gapsAfter = scanGaps(result.features, toleranceMeters);
        const gapsClosed = Math.max(0, gapsFound - gapsAfter);

        resolve({ result, sliversRemovedCount, gapsFound, gapsClosed });
      },
    );
  });

// ---------------------------------------------------------------------------
// Overshoot fix
// ---------------------------------------------------------------------------
const findClosestIntersectionToEndpoint = (
  intersections: any,
  endPt: any,
  startPt: any,
  toleranceKm: number,
): any | null => {
  let best: any = null;
  let bestDist = Infinity;

  for (const pt of intersections.features) {
    const distToEnd = distance(endPt, pt, { units: "kilometers" });
    const distToStart = distance(startPt, pt, { units: "kilometers" });
    if (
      distToEnd <= toleranceKm &&
      distToEnd < distToStart &&
      distToEnd < bestDist
    ) {
      bestDist = distToEnd;
      best = pt;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// MultiLineString flatten / reassemble
// ---------------------------------------------------------------------------
const flattenLineFeatures = (
  features: any[],
): { flat: any[]; wasMulti: Map<number, boolean> } => {
  const flat: any[] = [];
  const wasMulti = new Map<number, boolean>();

  features.forEach((feature, originalIndex) => {
    wasMulti.set(originalIndex, feature.geometry.type === "MultiLineString");

    if (feature.geometry.type === "MultiLineString") {
      feature.geometry.coordinates.forEach(
        (coords: number[][], partIndex: number) => {
          flat.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {
              ...feature.properties,
              __originalIndex: originalIndex,
              __partIndex: partIndex,
            },
          });
        },
      );
    } else {
      flat.push({
        ...feature,
        properties: {
          ...feature.properties,
          __originalIndex: originalIndex,
          __partIndex: 0,
        },
      });
    }
  });

  return { flat, wasMulti };
};

const reassembleMultiLines = (
  healedFlat: any[],
  wasMulti: Map<number, boolean>,
): any[] => {
  const groups = new Map<number, any[]>();

  for (const feature of healedFlat) {
    const idx = feature.properties.__originalIndex;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx)!.push(feature);
  }

  const result: any[] = [];

  groups.forEach((parts, originalIndex) => {
    const cleanProps = { ...parts[0].properties };
    delete cleanProps.__originalIndex;
    delete cleanProps.__partIndex;

    if (wasMulti.get(originalIndex) && parts.length > 1) {
      result.push({
        type: "Feature",
        geometry: {
          type: "MultiLineString",
          coordinates: parts
            .sort((a, b) => a.properties.__partIndex - b.properties.__partIndex)
            .map((p: any) => p.geometry.coordinates),
        },
        properties: cleanProps,
      });
    } else {
      result.push({ ...parts[0], properties: cleanProps });
    }
  });

  return result;
};

// ---------------------------------------------------------------------------
// Line topology healer — undershoot + overshoot, O(n log n) via RBush
// ---------------------------------------------------------------------------
const healLineTopologies = (geojson: any, toleranceKm: number) => {
  let healedCount = 0;
  if (geojson.type !== "FeatureCollection") return { geojson, healedCount };

  const lines = geojson.features;
  const lineIndex = buildIndex(lines);

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    let coords = currentLine.geometry.coordinates;
    if (coords.length < 2) continue;

    const startPt = point(coords[0]);
    const endPt = point(coords[coords.length - 1]);
    const offset = toleranceKm / 111.32;
    const [sLng, sLat] = coords[0];
    const [eLng, eLat] = coords[coords.length - 1];

    const startCandidates = lineIndex.search({
      minX: sLng - offset,
      minY: sLat - offset,
      maxX: sLng + offset,
      maxY: sLat + offset,
    });
    const endCandidates = lineIndex.search({
      minX: eLng - offset,
      minY: eLat - offset,
      maxX: eLng + offset,
      maxY: eLat + offset,
    });

    let minStartDist = Infinity,
      minEndDist = Infinity;
    let bestStartSnap: any = null,
      bestEndSnap: any = null;

    for (const item of startCandidates) {
      if (item.idx === i) continue;
      const snap = nearestPointOnLine(lines[item.idx], startPt);
      const d = distance(startPt, snap, { units: "kilometers" });
      if (d < minStartDist) {
        minStartDist = d;
        bestStartSnap = snap.geometry.coordinates;
      }
    }
    for (const item of endCandidates) {
      if (item.idx === i) continue;
      const snap = nearestPointOnLine(lines[item.idx], endPt);
      const d = distance(endPt, snap, { units: "kilometers" });
      if (d < minEndDist) {
        minEndDist = d;
        bestEndSnap = snap.geometry.coordinates;
      }
    }

    let modified = false;
    if (minStartDist > 0 && minStartDist <= toleranceKm && bestStartSnap) {
      coords[0] = bestStartSnap;
      modified = true;
    }
    if (minEndDist > 0 && minEndDist <= toleranceKm && bestEndSnap) {
      coords[coords.length - 1] = bestEndSnap;
      modified = true;
    }

    for (const item of endCandidates) {
      if (item.idx === i) continue;
      const intersections = lineIntersect(currentLine, lines[item.idx]);
      if (intersections.features.length === 0) continue;

      const best = findClosestIntersectionToEndpoint(
        intersections,
        endPt,
        startPt,
        toleranceKm,
      );
      if (best) {
        coords = lineSlice(startPt, best, currentLine).geometry.coordinates;
        modified = true;
        break;
      }
    }

    if (modified) {
      currentLine.geometry.coordinates = coords;
      healedCount++;
    }
  }

  return { geojson: featureCollection(lines), healedCount };
};

// ---------------------------------------------------------------------------
// Gap scanner — O(n log n) via RBush
// ---------------------------------------------------------------------------
const scanGaps = (features: any[], toleranceMeters: number): number => {
  if (features.length < 2) return 0;

  const index = buildIndex(features);
  const offsetDeg = (toleranceMeters * GAP_SNAP_MULTIPLIER) / 111320;
  const counted = new Set<string>();
  let gapCount = 0;

  for (let i = 0; i < features.length; i++) {
    const [minX, minY, maxX, maxY] = bbox(features[i]);
    const candidates = index.search({
      minX: minX - offsetDeg,
      minY: minY - offsetDeg,
      maxX: maxX + offsetDeg,
      maxY: maxY + offsetDeg,
    });

    for (const item of candidates) {
      const j = item.idx;
      if (j <= i) continue;
      const pairKey = `${i}:${j}`;
      if (counted.has(pairKey)) continue;
      try {
        if (!booleanIntersects(features[i], features[j])) {
          gapCount++;
          counted.add(pairKey);
        }
      } catch {
        /* degenerate — skip */
      }
    }
  }

  return gapCount;
};

// ---------------------------------------------------------------------------
// Polygon overlap detection & conditional healing — MULTI-PASS
//
// WHY MULTI-PASS IS NECESSARY (the bug being fixed here):
//
//   A single-pass approach builds one RBush index from the ORIGINAL bboxes
//   and never rebuilds it. Consider three polygons A, B, C where:
//     - A and B overlap slightly (should merge)
//     - C sits right where merged(A+B) would land, but is NOT near
//       original A or original B individually
//
//   Single pass:
//     i=A → finds B via index → merges → resultMap[A] = grown(A+B)
//     i=C → searches index for candidates near C
//         → index still has ORIGINAL small bboxes for A and B
//         → grown(A+B)'s larger bbox is NOT reflected in the index
//         → C never finds the merged polygon as a candidate
//         → a REAL overlap between C and merged(A+B) is silently missed
//
//   Fix: after each pass, if any merge happened, rebuild the index from the
//   CURRENT feature set and run another pass. This guarantees every bbox
//   the index holds is accurate for candidate search. Passes stop as soon
//   as a pass produces zero merges (fixed point reached), which is usually
//   1–2 passes for realistic cadastral clusters. MAX_OVERLAP_PASSES caps
//   the loop so pathological input can't hang the worker.
//
// CRITICAL PAIR DEDUPLICATION ACROSS PASSES:
//   Untouched polygons keep the same object identity across passes (they're
//   never replaced), so a critical pair that doesn't merge would otherwise
//   be re-detected and re-logged every single pass. A WeakMap assigns each
//   feature object a stable numeric uid on first sight; pairs are deduped
//   by uid so each distinct critical relationship is logged exactly once.
//   A newly merged polygon is a NEW object with a NEW uid, so if it goes on
//   to have a critical relationship with something else, that gets logged
//   too — correctly, since the merged polygon's area/shape has changed and
//   is new information, not a repeat.
//
// FLOAT_EDGE_EPSILON GUARD (separate earlier bug, still enforced here):
//   After a merge, the grown polygon shares an exact edge with whatever it
//   didn't merge with. @turf/intersect on two polygons sharing an exact
//   edge can return a near-zero-area artefact instead of null. Without a
//   large enough epsilon guard that artefact's tiny positive area produces
//   a tiny ratio, which falls below the merge threshold and triggers a
//   FALSE merge of an untouched, correctly-adjacent polygon.
// ---------------------------------------------------------------------------
interface OverlapEntry {
  type: "healed" | "critical";
  featureIndexA: number;
  featureIndexB: number;
  featureIdA: string | null;
  featureIdB: string | null;
  overlapAreaM2: number;
  overlapRatio: number;
  overlapBbox: [number, number, number, number];
  status: "Merged" | "CriticalError";
}

const healPolygonOverlaps = (
  features: any[],
  overlapThresholdRatio: number,
): {
  features: any[];
  overlapsHealed: number;
  overlapsCritical: number;
  overlapErrorLog: OverlapEntry[];
} => {
  const overlapErrorLog: OverlapEntry[] = [];

  if (features.length < 2) {
    return {
      features,
      overlapsHealed: 0,
      overlapsCritical: 0,
      overlapErrorLog,
    };
  }

  let uidCounter = 0;
  const uidMap = new WeakMap<object, number>();
  const getUid = (f: object): number => {
    if (!uidMap.has(f)) uidMap.set(f, uidCounter++);
    return uidMap.get(f)!;
  };
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  const seenCriticalPairs = new Set<string>();
  let current = features;
  let totalHealed = 0;
  let totalCritical = 0;

  for (let pass = 0; pass < MAX_OVERLAP_PASSES; pass++) {
    // Fresh index every pass — this is the core fix. bboxes always current.
    const index = buildIndex(current);
    const mergedAway = new Set<number>();
    const resultMap = new Map<number, any>();
    current.forEach((f, i) => resultMap.set(i, f));

    let mergedThisPass = 0;

    for (let i = 0; i < current.length; i++) {
      if (mergedAway.has(i)) continue;

      const featureA = resultMap.get(i)!;
      let areaA: number;
      try {
        areaA = area(featureA);
      } catch {
        continue;
      }
      if (areaA <= 0) continue;

      const [minX, minY, maxX, maxY] = bbox(featureA);
      const candidates = index.search({ minX, minY, maxX, maxY });

      for (const item of candidates) {
        const j = item.idx;
        if (j <= i || mergedAway.has(j)) continue;

        const featureB = resultMap.get(j);
        if (!featureB) continue;

        let areaB: number;
        try {
          areaB = area(featureB);
        } catch {
          continue;
        }
        if (areaB <= 0) continue;

        let overlapGeom: any;
        try {
          overlapGeom = intersect(featureCollection([featureA, featureB]));
        } catch {
          continue;
        }
        if (!overlapGeom) continue;

        let overlapAreaM2: number;
        try {
          overlapAreaM2 = area(overlapGeom);
        } catch {
          continue;
        }

        // Guard against shared-edge floating-point artefacts
        if (overlapAreaM2 <= FLOAT_EDGE_EPSILON) continue;

        const smallerArea = Math.min(areaA, areaB);
        const overlapRatio = overlapAreaM2 / smallerArea;
        const overlapBbox = bbox(overlapGeom) as [
          number,
          number,
          number,
          number,
        ];
        const featureIdA = featureA.id ?? featureA.properties?.id ?? null;
        const featureIdB = featureB.id ?? featureB.properties?.id ?? null;

        if (overlapRatio < overlapThresholdRatio) {
          // Small overlap → merge. Larger polygon's properties win.
          let merged: any;
          try {
            merged = union(featureCollection([featureA, featureB]));
          } catch {
            const key = pairKey(getUid(featureA), getUid(featureB));
            if (!seenCriticalPairs.has(key)) {
              seenCriticalPairs.add(key);
              totalCritical++;
              overlapErrorLog.push({
                type: "critical",
                featureIndexA: i,
                featureIndexB: j,
                featureIdA,
                featureIdB,
                overlapAreaM2,
                overlapRatio,
                overlapBbox,
                status: "CriticalError",
              });
            }
            continue;
          }

          const winnerProps =
            areaA >= areaB
              ? { ...featureA.properties, __mergedFrom: featureIdB ?? j }
              : { ...featureB.properties, __mergedFrom: featureIdA ?? i };

          merged.properties = winnerProps;
          merged.id = areaA >= areaB ? (featureA.id ?? i) : (featureB.id ?? j);

          resultMap.set(i, merged);
          mergedAway.add(j);
          resultMap.delete(j);

          areaA = area(merged);
          mergedThisPass++;
          totalHealed++;

          overlapErrorLog.push({
            type: "healed",
            featureIndexA: i,
            featureIndexB: j,
            featureIdA,
            featureIdB,
            overlapAreaM2,
            overlapRatio,
            overlapBbox,
            status: "Merged",
          });
        } else {
          // Large overlap → critical error, deduped across passes by uid pair
          const key = pairKey(getUid(featureA), getUid(featureB));
          if (!seenCriticalPairs.has(key)) {
            seenCriticalPairs.add(key);
            totalCritical++;
            overlapErrorLog.push({
              type: "critical",
              featureIndexA: i,
              featureIndexB: j,
              featureIdA,
              featureIdB,
              overlapAreaM2,
              overlapRatio,
              overlapBbox,
              status: "CriticalError",
            });
            console.error(
              `🔴 [SnapGIS] CRITICAL OVERLAP — ` +
                `${featureIdA ?? i} ↔ ${featureIdB ?? j} | ` +
                `${(overlapRatio * 100).toFixed(1)}% of smaller polygon ` +
                `(${overlapAreaM2.toFixed(4)} m²) | pass ${pass + 1}`,
            );
          }
        }
      }
    }

    current = Array.from(resultMap.values());

    if (mergedThisPass === 0) break; // fixed point — no more merges possible
    if (pass === MAX_OVERLAP_PASSES - 1) {
      console.warn(
        `⚠️ [SnapGIS] Overlap healing hit MAX_OVERLAP_PASSES (${MAX_OVERLAP_PASSES}) ` +
          `without converging — some cascading overlaps may remain unresolved.`,
      );
    }
  }

  return {
    features: current,
    overlapsHealed: totalHealed,
    overlapsCritical: totalCritical,
    overlapErrorLog,
  };
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
export const gisWorker = new Worker(
  "gis-processing-queue",
  async (job: Job<GisJobData>) => {
    const {
      fileName,
      originalName,
      filePath,
      size,
      tolerance,
      overlapThresholdRatio,
      nearDuplicateMaxOffsetMeters,
      nearDuplicateMinIoU,
    } = job.data;

    const usertolerance = tolerance || 25;
    const lineToleranceKm = usertolerance / 1_000_000;
    const polyToleranceMeters = usertolerance / 1000;
    const minSliverAreaM2 = computeMinSliverAreaM2(polyToleranceMeters);
    const effectiveOverlapRatio =
      overlapThresholdRatio ?? DEFAULT_OVERLAP_THRESHOLD;
    const effectiveNearDuplicateMaxOffsetMeters =
      nearDuplicateMaxOffsetMeters ?? DEFAULT_NEAR_DUPLICATE_MAX_OFFSET_M;
    const effectiveNearDuplicateMinIoU =
      nearDuplicateMinIoU ?? DEFAULT_NEAR_DUPLICATE_MIN_IOU;

    console.log(
      `🤖 [SnapGIS Worker] Job ${job.id} | ${originalName} ` +
        `| tolerance: ${usertolerance}mm | overlapRatio: ${effectiveOverlapRatio}`,
    );

    if (!fs.existsSync(filePath))
      throw new Error(`File not found: ${filePath}`);

    const ext = path.extname(originalName).toLowerCase();
    let geojson: any;

    await job.updateProgress(10);

    if (ext === ".kml") {
      const xmlDoc = new DOMParser().parseFromString(
        fs.readFileSync(filePath, "utf-8"),
        "text/xml",
      );
      geojson = kml(xmlDoc);
    } else if (ext === ".kmz") {
      const zip = new AdmZip(filePath);
      const kmlEntry = zip
        .getEntries()
        .find((e) => e.entryName.endsWith(".kml"));
      if (!kmlEntry) throw new Error("KML not found inside KMZ.");
      const xmlDoc = new DOMParser().parseFromString(
        kmlEntry.getData().toString("utf-8"),
        "text/xml",
      );
      geojson = kml(xmlDoc);
    } else {
      geojson = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }

    // GEO-002 validates ring integrity while GEO-003 owns closure detection,
    // repair, and reporting. The GEO-002 processor delegates its safe closing
    // operation to GEO-003 so both reports describe the same single repair.
    const ringClosureDetection = detectOpenRings(geojson);
    const invalidRingResult = processInvalidRings(geojson);
    geojson = invalidRingResult.geojson;
    const invalidRingValidationReport = invalidRingResult.report;
    const ringClosureValidationReport = buildRingClosureReport(
      ringClosureDetection,
      invalidRingResult.repairedRingKeys,
    );
    const quarantinedFeatureIndexes = new Set(
      invalidRingValidationReport.unresolvedFeatureIndexes,
    );

    if (invalidRingValidationReport.invalidRingsFound > 0) {
      console.log(
        `🔴 [SnapGIS] Invalid rings — found: ` +
          `${invalidRingValidationReport.invalidRingsFound} | repaired: ` +
          `${invalidRingValidationReport.ringsRepaired} | unresolved issues: ` +
          `${invalidRingValidationReport.unresolvedIssues}`,
      );
    }

    if (ringClosureValidationReport.openRingsFound > 0) {
      console.log(
        `🟡 [SnapGIS] Ring closure — open: ` +
          `${ringClosureValidationReport.openRingsFound} | closed: ` +
          `${ringClosureValidationReport.ringsClosed} | unresolved: ` +
          `${ringClosureValidationReport.unresolvedOpenRings}`,
      );
    }

    // GEO-001 follows ring repair so consecutive duplicates in a newly
    // closed ring can be removed without violating ring structure.
    const duplicateVertexResult = processDuplicateVertices(geojson);
    geojson = duplicateVertexResult.geojson;
    const duplicateVertexValidationReport = duplicateVertexResult.report;

    if (duplicateVertexValidationReport.duplicatesFound > 0) {
      console.log(
        `🟠 [SnapGIS] Duplicate vertices — found: ` +
          `${duplicateVertexValidationReport.duplicatesFound} | removed: ` +
          `${duplicateVertexValidationReport.duplicatesRemoved} | unresolved: ` +
          `${duplicateVertexValidationReport.unresolvedDuplicates}`,
      );
    }

    // GEO-004 normalizes RFC 7946 winding before polygon topology work:
    // exterior rings counterclockwise, interior rings clockwise.
    const ringOrientationResult = processRingOrientation(geojson);
    geojson = ringOrientationResult.geojson;
    const ringOrientationValidationReport = ringOrientationResult.report;
    const unresolvedOrientationFeatureIndexes =
      ringOrientationValidationReport.unresolvedFeatureIndexes;
    for (const featureIndex of unresolvedOrientationFeatureIndexes) {
      quarantinedFeatureIndexes.add(featureIndex);
    }

    if (ringOrientationValidationReport.orientationIssuesFound > 0) {
      console.log(
        `🟢 [SnapGIS] Ring orientation — issues: ` +
          `${ringOrientationValidationReport.orientationIssuesFound} | normalized: ` +
          `${ringOrientationValidationReport.ringsNormalized} | unresolved: ` +
          `${ringOrientationValidationReport.unresolvedIssues}`,
      );
    }

    // GEO-005 validates holes after structural and winding normalization.
    // Only proven outside or tiny holes are removed; unresolved ambiguous
    // hole topology is quarantined from downstream polygon operations.
    const invalidHoleResult = processInvalidHoles(geojson, {
      tinyHoleAreaM2: minSliverAreaM2,
    });
    geojson = invalidHoleResult.geojson;
    const invalidHoleValidationReport = invalidHoleResult.report;
    for (
      const featureIndex of invalidHoleValidationReport.unresolvedFeatureIndexes
    ) {
      quarantinedFeatureIndexes.add(featureIndex);
    }

    if (invalidHoleValidationReport.invalidHolesFound > 0) {
      console.log(
        `🟤 [SnapGIS] Invalid holes — invalid: ` +
          `${invalidHoleValidationReport.invalidHolesFound} | removed: ` +
          `${invalidHoleValidationReport.holesRemoved} | unresolved: ` +
          `${invalidHoleValidationReport.unresolvedIssues}`,
      );
    }

    const quarantinedFeatures = geojson.features.filter(
      (_: any, featureIndex: number) =>
        quarantinedFeatureIndexes.has(featureIndex),
    );

    await job.updateProgress(20);

    const polyFeatures = geojson.features.filter(
      (f: any, featureIndex: number) =>
        !quarantinedFeatureIndexes.has(featureIndex) &&
        ["Polygon", "MultiPolygon"].includes(f.geometry?.type),
    );
    const lineFeatures = geojson.features.filter(
      (f: any, featureIndex: number) =>
        !quarantinedFeatureIndexes.has(featureIndex) &&
        ["LineString", "MultiLineString"].includes(f.geometry?.type),
    );
    const otherFeatures = geojson.features.filter(
      (f: any, featureIndex: number) =>
        !quarantinedFeatureIndexes.has(featureIndex) &&
        !["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(
          f.geometry?.type,
        ),
    );

    // [DUPLICATE DETECTION] Runs immediately after loading polygon features,
    // before overlap detection or any other topology processing. Everything
    // downstream (sliver pre-count, overlap healing) reads the deduplicated
    // array so an auto-removed exact duplicate is never double-processed.
    let duplicatesFound = 0;
    let exactDuplicates = 0;
    let topologicalDuplicates = 0;
    let nearDuplicates = 0;
    let duplicateErrorLog: DuplicateEntry[] = [];
    let polyFeaturesAfterDuplicates = polyFeatures;

    if (polyFeatures.length > 1) {
      const dupResult = detectDuplicatePolygons(polyFeatures, {
        nearDuplicateMaxOffsetMeters: effectiveNearDuplicateMaxOffsetMeters,
        nearDuplicateMinIoU: effectiveNearDuplicateMinIoU,
      });
      polyFeaturesAfterDuplicates = dupResult.features;
      duplicatesFound = dupResult.duplicatesFound;
      exactDuplicates = dupResult.exactDuplicates;
      topologicalDuplicates = dupResult.topologicalDuplicates;
      nearDuplicates = dupResult.nearDuplicates;
      duplicateErrorLog = dupResult.duplicateErrorLog;
      console.log(
        `🟣 [SnapGIS] Duplicates — exact: ${exactDuplicates} (removed) | ` +
          `topological: ${topologicalDuplicates} (reported) | near: ${nearDuplicates} (reported)`,
      );
    }

    await job.updateProgress(25);

    await job.updateProgress(30);

    let healedLineCount = 0;
    let processedLineFeatures = lineFeatures;

    if (lineFeatures.length > 0) {
      const { flat, wasMulti } = flattenLineFeatures(lineFeatures);
      const healed = healLineTopologies(
        featureCollection(flat),
        lineToleranceKm,
      );
      healedLineCount = healed.healedCount;
      processedLineFeatures = reassembleMultiLines(
        healed.geojson.features,
        wasMulti,
      );
    }

    const processedLines = featureCollection(processedLineFeatures);

    await job.updateProgress(40);

    const inputSliverCount = countSlivers(
      polyFeaturesAfterDuplicates,
      minSliverAreaM2,
    );

    // Overlap healing must run before kink detection — overlapping polygons
    // can produce false kink reports.
    let overlapsHealed = 0;
    let overlapsCritical = 0;
    let overlapErrorLog: OverlapEntry[] = [];
    let polyFeaturesAfterOverlap = polyFeaturesAfterDuplicates;

    if (polyFeaturesAfterDuplicates.length > 1) {
      const result = healPolygonOverlaps(
        polyFeaturesAfterDuplicates,
        effectiveOverlapRatio,
      );
      polyFeaturesAfterOverlap = result.features;
      overlapsHealed = result.overlapsHealed;
      overlapsCritical = result.overlapsCritical;
      overlapErrorLog = result.overlapErrorLog;
      console.log(
        `🔷 [SnapGIS] Overlaps — merged: ${overlapsHealed} | critical: ${overlapsCritical}`,
      );
    }

    await job.updateProgress(50);

    let kinkCount = 0;
    let healedPolysList: any[] = [];

    for (const feature of polyFeaturesAfterOverlap) {
      const featureKinks = kinks(feature);
      if (featureKinks.features.length > 0) {
        kinkCount += featureKinks.features.length;
        healedPolysList.push(...unkinkPolygon(feature).features);
      } else {
        healedPolysList.push(feature);
      }
    }

    await job.updateProgress(60);

    // rewind MUST run before the featureCollection snapshot — otherwise
    // Mapshaper receives un-rewound polygons and silently drops holes.
    let processedPolys = featureCollection([] as any[]);
    let sliversRemovedCount = 0;
    let gapsFound = 0;
    let gapsClosed = 0;
    let postProcessingRingsOrientationNormalized = 0;
    let postProcessingRingOrientationIssuesUnresolved = 0;

    if (healedPolysList.length > 0) {
      const finalOrientationResult = processRingOrientation(
        featureCollection(healedPolysList),
      );
      healedPolysList = finalOrientationResult.geojson.features;
      postProcessingRingsOrientationNormalized =
        finalOrientationResult.report.ringsNormalized;
      postProcessingRingOrientationIssuesUnresolved =
        finalOrientationResult.report.unresolvedIssues;
      processedPolys = featureCollection(healedPolysList);

      const mapshaperOutput = await runMapshaperPipeline(
        processedPolys,
        polyToleranceMeters,
      );
      const outputOrientationResult = processRingOrientation(
        mapshaperOutput.result,
      );
      processedPolys = outputOrientationResult.geojson;
      postProcessingRingsOrientationNormalized +=
        outputOrientationResult.report.ringsNormalized;
      postProcessingRingOrientationIssuesUnresolved +=
        outputOrientationResult.report.unresolvedIssues;
      sliversRemovedCount = mapshaperOutput.sliversRemovedCount;
      gapsFound = mapshaperOutput.gapsFound;
      gapsClosed = mapshaperOutput.gapsClosed;
    }

    await job.updateProgress(80);

    geojson.features = [
      ...processedLines.features,
      ...processedPolys.features,
      ...otherFeatures,
    ];

    const optimizedGeojson = truncate(geojson, {
      precision: 9,
      coordinates: 3,
    });
    optimizedGeojson.features.push(...quarantinedFeatures);

    const outputDir = path.join(__dirname, "../../uploads/cleaned_files");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFileName = `cleaned-${fileName.replace(ext, ".geojson")}`;
    const outputFilePath = path.join(outputDir, outputFileName);
    fs.writeFileSync(outputFilePath, JSON.stringify(optimizedGeojson));

    const newSize = fs.statSync(outputFilePath).size;
    await job.updateProgress(100);

    return {
      success: true,
      kinksFound: kinkCount,
      healedUndershootOvershoot: healedLineCount,
      inputSliverCount,
      sliversRemovedCount,
      gapsFound,
      gapsClosed,
      overlapsHealed,
      overlapsCritical,
      overlapErrorLog,
      duplicatesFound,
      exactDuplicates,
      topologicalDuplicates,
      nearDuplicates,
      duplicateErrorLog,
      duplicateVerticesFound:
        duplicateVertexValidationReport.duplicatesFound,
      duplicateVerticesRemoved:
        duplicateVertexValidationReport.duplicatesRemoved,
      duplicateVerticesUnresolved:
        duplicateVertexValidationReport.unresolvedDuplicates,
      duplicateVertexValidationReport,
      invalidRingsFound: invalidRingValidationReport.invalidRingsFound,
      invalidRingsRepaired: invalidRingValidationReport.ringsRepaired,
      invalidRingIssuesUnresolved:
        invalidRingValidationReport.unresolvedIssues,
      invalidRingValidationReport,
      openRingsFound: ringClosureValidationReport.openRingsFound,
      ringsAutoClosed: ringClosureValidationReport.ringsClosed,
      openRingsUnresolved:
        ringClosureValidationReport.unresolvedOpenRings,
      ringClosureValidationReport,
      ringOrientationIssuesFound:
        ringOrientationValidationReport.orientationIssuesFound,
      inputRingsOrientationNormalized:
        ringOrientationValidationReport.ringsNormalized,
      ringOrientationIssuesUnresolved:
        ringOrientationValidationReport.unresolvedIssues,
      postProcessingRingsOrientationNormalized,
      postProcessingRingOrientationIssuesUnresolved,
      ringsOrientationNormalized:
        ringOrientationValidationReport.ringsNormalized +
        postProcessingRingsOrientationNormalized,
      ringOrientationValidationReport,
      invalidHolesFound: invalidHoleValidationReport.invalidHolesFound,
      holesRemoved: invalidHoleValidationReport.holesRemoved,
      tinyHolesRemoved: invalidHoleValidationReport.tinyHolesRemoved,
      outsideHolesRemoved: invalidHoleValidationReport.outsideHolesRemoved,
      holeOrientationsNormalized:
        invalidHoleValidationReport.holeOrientationsNormalized,
      invalidHoleIssuesUnresolved:
        invalidHoleValidationReport.unresolvedIssues,
      invalidHoleValidationReport,
      appliedTinyHoleAreaM2: minSliverAreaM2,
      appliedTolerance: usertolerance,
      appliedOverlapThresholdRatio: effectiveOverlapRatio,
      appliedNearDuplicateMaxOffsetMeters:
        effectiveNearDuplicateMaxOffsetMeters,
      appliedNearDuplicateMinIoU: effectiveNearDuplicateMinIoU,
      originalSizeInBytes: size,
      optimizedSizeInBytes: newSize,
      downloadPath: `/uploads/cleaned_files/${outputFileName}`,
    };
  },
  { connection: redisConnection as any, concurrency: 2 },
);

gisWorker.on("completed", (job) => {
  console.log(`✅ [SnapGIS Worker] Job ${job.id} COMPLETED.`);
});

gisWorker.on("failed", (job, err) => {
  console.error(`❌ [SnapGIS Worker] Job ${job?.id} FAILED: ${err.message}`);
});
