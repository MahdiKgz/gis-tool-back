// @ts-nocheck
import { Worker, Job } from "bullmq";
import { redisConnection } from "../services/queue.service";
import path from "path";
import fs from "fs";

// --- Turf.js Modules ---
import distance from "@turf/distance";
import { point, featureCollection } from "@turf/helpers";
import area from "@turf/area";
import bbox from "@turf/bbox";
import intersect from "@turf/intersect";
import union from "@turf/union";

// --- Spatial Index ---
import RBush from "rbush";

import {
  capturePolygonAreaBaseline,
  processCollapsedPolygons,
} from "../processing/collapsed-polygons";
import {
  coordinatePrecisionQuarantineFeatureIndexes,
  prepareOutputCoordinates,
  processCoordinatePrecision,
} from "../processing/coordinate-precision";
import { processDuplicateVertices } from "../processing/duplicate-vertices";
import { processGeometryDimensions } from "../processing/geometry-dimensions";
import { processGeometryTypes } from "../processing/geometry-types";
import {
  computeGapToleranceMeters,
  processGaps,
} from "../processing/gaps";
import { processInvalidHoles } from "../processing/invalid-holes";
import { processInvalidRings } from "../processing/invalid-rings";
import { processLineTopologyWithPolygonContext } from "../processing/line-topology";
import { processMultipartIntegrity } from "../processing/multipart-integrity";
import {
  buildRingClosureReport,
  detectOpenRings,
} from "../processing/ring-closure";
import { processRingOrientation } from "../processing/ring-orientation";
import { canonicalRingSignature } from "../processing/shared/ring-signature";
import { processSelfIntersections } from "../processing/self-intersections";
import { processSpikes } from "../processing/spikes";
import {
  computeSliverAreaThresholdM2,
  processSlivers,
} from "../processing/slivers";
import { processTinyPolygons } from "../processing/tiny-polygons";
import { processZeroAreaPolygons } from "../processing/zero-area-polygons";
import { readGisFile } from "../services/gis-file.service";
import {
  markAnalysisCompleted,
  markAnalysisCancelled,
  markAnalysisFailed,
  getAnalysis,
  markAnalysisProcessing,
  markAnalysisProgress,
} from "../services/analysis-store.service";
import { GisJobData } from "../types/gis-job";
import { countAppliedRepairs } from "../services/heal-result.service";
import {
  createHealingProgress,
  parseHealingProgress,
} from "../services/heal-progress.service";
import { updateUploadHealingMetrics } from "../services/upload-record.service";
import {
  isHealingCancellationRequested,
  throwIfHealingCancelled,
} from "../services/heal-cancellation.service";
const mapshaper = require("mapshaper");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
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
// multiple of the offset tolerance, mirroring the gap snap multiplier
// precedent — guards against missing a near-duplicate whose bbox sits just
// past a tightly-drawn query window.
const NEAR_DUPLICATE_SEARCH_MARGIN_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
              (signature, ringIndex) => signature === signaturesB[ringIndex],
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
// Explicit polygon repair followed by Mapshaper topology cleanup
// ---------------------------------------------------------------------------
const runMapshaperPipeline = async (
  geojson: any,
  toleranceMeters: number,
): Promise<{
  result: any;
  sliversRemovedCount: number;
  sliversAbsorbedCount: number;
  sliversDeletedCount: number;
  sliverRepairValidationReport: any;
  gapsFound: number;
  gapsClosed: number;
  gapValidationReport: any;
}> =>
  new Promise((resolve, reject) => {
    const minAreaM2 = computeSliverAreaThresholdM2(toleranceMeters);
    const gapToleranceMeters = computeGapToleranceMeters(toleranceMeters);

    const sliverResult = processSlivers(
      geojson,
      {
        sliverAreaThresholdM2: minAreaM2,
      },
      true,
    );
    const gapResult = processGaps(
      sliverResult.geojson,
      { gapToleranceMeters, minimumGapWidthMeters: toleranceMeters },
      true,
    );

    if (gapResult.geojson.features.length === 0) {
      resolve({
        result: gapResult.geojson,
        sliversRemovedCount: sliverResult.report.sliversRemoved,
        sliversAbsorbedCount: sliverResult.report.sliversAbsorbed,
        sliversDeletedCount: sliverResult.report.sliversDeleted,
        sliverRepairValidationReport: sliverResult.report,
        gapsFound: gapResult.report.gapsFound,
        gapsClosed: gapResult.report.gapsRepaired,
        gapValidationReport: gapResult.report,
      });
      return;
    }

    const commands = [
      `-i input.json`,
      `-clean`,
      `-o output.json format=geojson`,
    ].join(" ");

    mapshaper.applyCommands(
      commands,
      { "input.json": JSON.stringify(gapResult.geojson) },
      (err: any, output: any) => {
        if (err) return reject(err);
        if (!output?.["output.json"])
          return reject(new Error("Mapshaper output missing"));

        const result = JSON.parse(output["output.json"].toString("utf-8"));
        const sliversRemovedCount = sliverResult.report.sliversRemoved;
        const sliversAbsorbedCount = sliverResult.report.sliversAbsorbed;
        const sliversDeletedCount = sliverResult.report.sliversDeleted;
        const gapsFound = gapResult.report.gapsFound;
        const gapsClosed = gapResult.report.gapsRepaired;

        resolve({
          result,
          sliversRemovedCount,
          sliversAbsorbedCount,
          sliversDeletedCount,
          sliverRepairValidationReport: sliverResult.report,
          gapsFound,
          gapsClosed,
          gapValidationReport: gapResult.report,
        });
      },
    );
  });

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
    const jobId = String(job.id);
    const cancellationCheckpoint = () => throwIfHealingCancelled(jobId);
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
    const polyToleranceMeters = usertolerance / 1000;
    const minSliverAreaM2 = computeSliverAreaThresholdM2(polyToleranceMeters);
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

    await cancellationCheckpoint();

    if (!fs.existsSync(filePath))
      throw new Error(`File not found: ${filePath}`);

    const ext = path.extname(originalName).toLowerCase();
    await job.updateProgress(createHealingProgress(10, "parsing"));
    let geojson: any = await readGisFile(filePath, originalName);
    await cancellationCheckpoint();

    // GEO-010 is the first semantic gate. Invalid feature geometries are
    // preserved for reporting but quarantined before specialized processors.
    const geometryTypeResult = processGeometryTypes(geojson);
    const geometryTypeValidationReport = geometryTypeResult.report;
    if (!geometryTypeValidationReport.rootValid) {
      throw new TypeError(
        `GEO-010 geometry type validation failed: ` +
          geometryTypeValidationReport.rootError,
      );
    }
    if (
      geometryTypeValidationReport.issues.some(
        (issue) => issue.code === "INVALID_FEATURE_OBJECT",
      )
    ) {
      throw new TypeError(
        "GEO-010 geometry type validation failed: " +
          "FeatureCollection contains a non-object feature entry",
      );
    }

    if (geometryTypeValidationReport.invalidGeometryTypesFound > 0) {
      console.log(
        `⬛ [SnapGIS] Geometry types — invalid: ` +
          `${geometryTypeValidationReport.invalidGeometryTypesFound}`,
      );
    }

    // GEO-011 validates complete finite positions and consistent arity before
    // coordinate-sequence processors interpret geometry contents.
    const geometryDimensionResult = processGeometryDimensions(geojson);
    const geometryDimensionValidationReport = geometryDimensionResult.report;
    if (geometryDimensionValidationReport.unresolvedIssues > 0) {
      console.log(
        `🟫 [SnapGIS] Geometry dimensions — invalid: ` +
          `${geometryDimensionValidationReport.unresolvedIssues}`,
      );
    }

    // GEO-012 validates MultiPolygon component structure and pair topology
    // with RBush candidate pruning before any multipart enters repair stages.
    const multipartIntegrityResult = processMultipartIntegrity(geojson);
    const multipartIntegrityValidationReport = multipartIntegrityResult.report;
    if (multipartIntegrityValidationReport.unresolvedIssues > 0) {
      console.log(
        `🟦 [SnapGIS] Multipart integrity — invalid: ` +
          `${multipartIntegrityValidationReport.invalidMultiPolygonsFound}`,
      );
    }

    // GEO-013 reports precision loss before any output rounding can merge
    // distinct vertices or exceed the safe floating-point grid.
    const coordinatePrecisionResult = processCoordinatePrecision(geojson, {
      maxDecimalPlaces: 9,
    });
    const coordinatePrecisionValidationReport =
      coordinatePrecisionResult.report;
    if (coordinatePrecisionValidationReport.unresolvedIssues > 0) {
      console.log(
        `🟩 [SnapGIS] Coordinate precision — issues: ` +
          `${coordinatePrecisionValidationReport.precisionIssuesFound}`,
      );
    }

    // GEO-009 keeps an O(p) area baseline rather than cloning the complete
    // input so later repair results can be distinguished from input defects.
    const polygonAreaBaseline = capturePolygonAreaBaseline(geojson);

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
    const coordinatePrecisionUnsafeFeatureIndexes =
      coordinatePrecisionQuarantineFeatureIndexes(
        coordinatePrecisionValidationReport,
      );
    const quarantinedFeatureIndexes = new Set([
      ...geometryTypeValidationReport.unresolvedFeatureIndexes,
      ...geometryDimensionValidationReport.unresolvedFeatureIndexes,
      ...multipartIntegrityValidationReport.unresolvedFeatureIndexes,
      ...coordinatePrecisionUnsafeFeatureIndexes,
      ...invalidRingValidationReport.unresolvedFeatureIndexes,
    ]);

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

    // Repair isolated exterior-ring crossings before winding validation.
    // A bow-tie has indeterminate signed area, so running orientation first
    // used to quarantine exactly the simple kink that the healer could fix.
    // Already-quarantined features are represented by null geometries in the
    // working view and merged back unchanged.
    const selfIntersectionInput = {
      ...geojson,
      features: geojson.features.map((feature: any, featureIndex: number) =>
        quarantinedFeatureIndexes.has(featureIndex)
          ? { ...feature, geometry: null }
          : feature,
      ),
    };
    const selfIntersectionResult = processSelfIntersections(
      selfIntersectionInput,
      true,
    );
    geojson = {
      ...geojson,
      features: geojson.features.map((feature: any, featureIndex: number) =>
        quarantinedFeatureIndexes.has(featureIndex)
          ? feature
          : selfIntersectionResult.geojson.features[featureIndex],
      ),
    };
    const selfIntersectionValidationReport = selfIntersectionResult.report;
    for (const featureIndex of
      selfIntersectionValidationReport.unresolvedFeatureIndexes) {
      quarantinedFeatureIndexes.add(featureIndex);
    }

    if (selfIntersectionValidationReport.selfIntersectionsFound > 0) {
      console.log(
        `🟦 [SnapGIS] Self-intersections — found: ` +
          `${selfIntersectionValidationReport.selfIntersectionsFound} | repaired: ` +
          `${selfIntersectionValidationReport.selfIntersectionsRepaired} | unresolved: ` +
          `${selfIntersectionValidationReport.unresolvedIssues}`,
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
    for (const featureIndex of invalidHoleValidationReport.unresolvedFeatureIndexes) {
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

    // GEO-006 removes high-confidence narrow backtracks. Candidates either
    // fit the metric tolerance or are strongly evidenced outward ring spikes;
    // every edit is still accepted only after full feature-topology checks.
    const spikeResult = processSpikes(geojson, {
      baseToleranceMeters: polyToleranceMeters,
    });
    geojson = spikeResult.geojson;
    const spikeValidationReport = spikeResult.report;
    for (const featureIndex of spikeValidationReport.unresolvedFeatureIndexes) {
      quarantinedFeatureIndexes.add(featureIndex);
    }

    if (spikeValidationReport.spikesFound > 0) {
      console.log(
        `🟧 [SnapGIS] Spikes — found: ` +
          `${spikeValidationReport.spikesFound} | removed: ` +
          `${spikeValidationReport.spikesRemoved} | unresolved: ` +
          `${spikeValidationReport.unresolvedSpikes}`,
      );
    }

    // GEO-009 compares the positive-area input baseline to the repaired
    // geometry. Collapses are never guessed back into existence.
    const collapsedPolygonResult = processCollapsedPolygons(
      polygonAreaBaseline,
      geojson,
    );
    const collapsedPolygonValidationReport = collapsedPolygonResult.report;
    for (const featureIndex of collapsedPolygonValidationReport.unresolvedFeatureIndexes) {
      quarantinedFeatureIndexes.add(featureIndex);
    }

    if (collapsedPolygonValidationReport.collapsedPolygonsFound > 0) {
      console.log(
        `🟪 [SnapGIS] Collapsed polygons — found: ` +
          `${collapsedPolygonValidationReport.collapsedPolygonsFound}`,
      );
    }

    // GEO-007 is report-only: a zero-area polygon cannot be reconstructed
    // safely without domain knowledge, so its owning feature is quarantined.
    const zeroAreaPolygonResult = processZeroAreaPolygons(geojson);
    const zeroAreaPolygonValidationReport = zeroAreaPolygonResult.report;
    for (const featureIndex of zeroAreaPolygonValidationReport.unresolvedFeatureIndexes) {
      quarantinedFeatureIndexes.add(featureIndex);
    }

    if (zeroAreaPolygonValidationReport.zeroAreaPolygonsFound > 0) {
      console.log(
        `🟥 [SnapGIS] Zero-area polygons — found: ` +
          `${zeroAreaPolygonValidationReport.zeroAreaPolygonsFound}`,
      );
    }

    // Slivers use both the tolerance-derived area threshold and the
    // scale-independent compactness gate. Minimum-area components retain the
    // deletion policy; compactness-only components require a dominant,
    // substantially larger adjacent parcel before absorption is available.
    const inputSliverValidationReport = processSlivers(geojson, {
      sliverAreaThresholdM2: minSliverAreaM2,
    }).report;
    const inputSliverCount = inputSliverValidationReport.sliversFound;
    const repairableSliverFeatureIndexes = new Set(
      inputSliverValidationReport.issues
        .filter((issue) => issue.recommendedAction === "AutoRepair")
        .map((issue) => issue.featureIndex),
    );

    // GEO-008 distinguishes small positive-area components from GEO-007's
    // exact-zero degeneracy and reports them without destructive removal.
    const tinyPolygonResult = processTinyPolygons(geojson, {
      tinyPolygonAreaM2: minSliverAreaM2,
    });
    const tinyPolygonValidationReport = tinyPolygonResult.report;
    for (const featureIndex of tinyPolygonValidationReport.unresolvedFeatureIndexes) {
      if (!repairableSliverFeatureIndexes.has(featureIndex)) {
        quarantinedFeatureIndexes.add(featureIndex);
      }
    }

    if (tinyPolygonValidationReport.tinyPolygonsFound > 0) {
      console.log(
        `🟨 [SnapGIS] Tiny polygons — found: ` +
          `${tinyPolygonValidationReport.tinyPolygonsFound}`,
      );
    }

    const quarantinedFeatures = geojson.features.filter(
      (_: any, featureIndex: number) =>
        quarantinedFeatureIndexes.has(featureIndex),
    );

    await job.updateProgress(
      createHealingProgress(20, "error-detection", {
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

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
    // downstream overlap healing reads the deduplicated
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

    await job.updateProgress(
      createHealingProgress(25, "error-detection", {
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    await job.updateProgress(
      createHealingProgress(30, "healing", {
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    await job.updateProgress(
      createHealingProgress(40, "healing", {
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    // Resolve polygon overlaps before gap/sliver work so downstream
    // adjacency decisions use the geometry that will actually be emitted.
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

    await job.updateProgress(
      createHealingProgress(50, "healing", {
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    const kinkCount =
      selfIntersectionValidationReport.selfIntersectionsFound;
    let healedPolysList: any[] = polyFeaturesAfterOverlap;

    await job.updateProgress(
      createHealingProgress(60, "healing", {
        kink: kinkCount,
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    // rewind MUST run before the featureCollection snapshot — otherwise
    // Mapshaper receives un-rewound polygons and silently drops holes.
    let processedPolys = featureCollection([] as any[]);
    let sliversRemovedCount = 0;
    let sliversAbsorbedCount = 0;
    let sliversDeletedCount = 0;
    let sliverRepairValidationReport: any = null;
    let gapsFound = 0;
    let gapsClosed = 0;
    let gapValidationReport: any = null;
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
      await cancellationCheckpoint();
      const outputOrientationResult = processRingOrientation(
        mapshaperOutput.result,
      );
      processedPolys = outputOrientationResult.geojson;
      postProcessingRingsOrientationNormalized +=
        outputOrientationResult.report.ringsNormalized;
      postProcessingRingOrientationIssuesUnresolved +=
        outputOrientationResult.report.unresolvedIssues;
      sliversRemovedCount = mapshaperOutput.sliversRemovedCount;
      sliversAbsorbedCount = mapshaperOutput.sliversAbsorbedCount;
      sliversDeletedCount = mapshaperOutput.sliversDeletedCount;
      sliverRepairValidationReport =
        mapshaperOutput.sliverRepairValidationReport;
      gapsFound = mapshaperOutput.gapsFound;
      gapsClosed = mapshaperOutput.gapsClosed;
      gapValidationReport = mapshaperOutput.gapValidationReport;
    }

    // Endpoint topology must see polygon boundaries. The former worker path
    // passed only line features even though dry-run used the complete dataset,
    // so every line-to-polygon undershoot/overshoot vanished during healing.
    // Run this last, against the final repaired polygon boundaries, and keep
    // only the line prefix in the emitted line collection.
    const lineTopologyResult = processLineTopologyWithPolygonContext(
      lineFeatures,
      processedPolys.features,
      { toleranceMeters: polyToleranceMeters },
    );
    const undershootValidationReport = lineTopologyResult.reports.undershoots;
    const overshootValidationReport = lineTopologyResult.reports.overshoots;
    const healedLineCount = new Set(
      [
        ...undershootValidationReport.issues,
        ...overshootValidationReport.issues,
      ]
        .filter((issue) => issue.status === "Repaired")
        .map((issue) => issue.featureIndex),
    ).size;
    const processedLines = lineTopologyResult.geojson;

    await job.updateProgress(
      createHealingProgress(80, "report-generation", {
        gap: gapsFound,
        kink: kinkCount,
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    geojson.features = [
      ...processedLines.features,
      ...processedPolys.features,
      ...otherFeatures,
    ];

    const optimizedGeojson = prepareOutputCoordinates(geojson, 9);
    optimizedGeojson.features.push(...quarantinedFeatures);

    const outputDir = path.join(__dirname, "../../uploads/cleaned_files");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFileName = `cleaned-${fileName.replace(ext, ".geojson")}`;
    const outputFilePath = path.join(outputDir, outputFileName);
    await cancellationCheckpoint();
    fs.writeFileSync(outputFilePath, JSON.stringify(optimizedGeojson));

    if (await isHealingCancellationRequested(jobId)) {
      fs.rmSync(outputFilePath, { force: true });
      await cancellationCheckpoint();
    }

    const newSize = fs.statSync(outputFilePath).size;
    await job.updateProgress(
      createHealingProgress(100, "report-generation", {
        gap: gapsFound,
        kink: kinkCount,
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );

    return {
      success: true,
      kinksFound: kinkCount,
      selfIntersectionsRepaired:
        selfIntersectionValidationReport.selfIntersectionsRepaired,
      selfIntersectionValidationReport,
      healedUndershootOvershoot: healedLineCount,
      undershootsFound: undershootValidationReport.undershootsFound,
      undershootsRepaired: undershootValidationReport.undershootsRepaired,
      undershootValidationReport,
      overshootsFound: overshootValidationReport.overshootsFound,
      overshootsRepaired: overshootValidationReport.overshootsRepaired,
      overshootValidationReport,
      inputSliverCount,
      sliversRemovedCount,
      sliversAbsorbedCount,
      sliversDeletedCount,
      inputSliverValidationReport,
      sliverRepairValidationReport,
      gapsFound,
      gapsClosed,
      gapValidationReport,
      overlapsHealed,
      overlapsCritical,
      overlapErrorLog,
      duplicatesFound,
      exactDuplicates,
      topologicalDuplicates,
      nearDuplicates,
      duplicateErrorLog,
      duplicateVerticesFound: duplicateVertexValidationReport.duplicatesFound,
      duplicateVerticesRemoved:
        duplicateVertexValidationReport.duplicatesRemoved,
      duplicateVerticesUnresolved:
        duplicateVertexValidationReport.unresolvedDuplicates,
      duplicateVertexValidationReport,
      invalidRingsFound: invalidRingValidationReport.invalidRingsFound,
      invalidRingsRepaired: invalidRingValidationReport.ringsRepaired,
      invalidRingIssuesUnresolved: invalidRingValidationReport.unresolvedIssues,
      invalidRingValidationReport,
      openRingsFound: ringClosureValidationReport.openRingsFound,
      ringsAutoClosed: ringClosureValidationReport.ringsClosed,
      openRingsUnresolved: ringClosureValidationReport.unresolvedOpenRings,
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
      invalidHoleIssuesUnresolved: invalidHoleValidationReport.unresolvedIssues,
      invalidHoleValidationReport,
      appliedTinyHoleAreaM2: minSliverAreaM2,
      spikesFound: spikeValidationReport.spikesFound,
      spikesRemoved: spikeValidationReport.spikesRemoved,
      spikesUnresolved: spikeValidationReport.unresolvedSpikes,
      spikeValidationReport,
      appliedSpikeBaseToleranceMeters: polyToleranceMeters,
      zeroAreaPolygonsFound:
        zeroAreaPolygonValidationReport.zeroAreaPolygonsFound,
      zeroAreaPolygonIssuesUnresolved:
        zeroAreaPolygonValidationReport.unresolvedIssues,
      zeroAreaPolygonValidationReport,
      tinyPolygonsFound: tinyPolygonValidationReport.tinyPolygonsFound,
      tinyPolygonIssuesUnresolved: tinyPolygonValidationReport.unresolvedIssues,
      tinyPolygonValidationReport,
      appliedTinyPolygonAreaM2: minSliverAreaM2,
      collapsedPolygonsFound:
        collapsedPolygonValidationReport.collapsedPolygonsFound,
      collapsedPolygonIssuesUnresolved:
        collapsedPolygonValidationReport.unresolvedIssues,
      collapsedPolygonValidationReport,
      invalidGeometryTypesFound:
        geometryTypeValidationReport.invalidGeometryTypesFound,
      geometryTypeIssuesUnresolved:
        geometryTypeValidationReport.unresolvedIssues,
      geometryTypeValidationReport,
      invalidGeometryDimensionsFound:
        geometryDimensionValidationReport.invalidDimensionsFound +
        geometryDimensionValidationReport.inconsistentDimensionsFound,
      invalidCoordinateValuesFound:
        geometryDimensionValidationReport.invalidCoordinateValuesFound,
      geometryDimensionIssuesUnresolved:
        geometryDimensionValidationReport.unresolvedIssues,
      geometryDimensionValidationReport,
      invalidMultiPolygonsFound:
        multipartIntegrityValidationReport.invalidMultiPolygonsFound,
      multipartIntegrityIssuesUnresolved:
        multipartIntegrityValidationReport.unresolvedIssues,
      multipartIntegrityValidationReport,
      coordinatePrecisionIssuesFound:
        coordinatePrecisionValidationReport.precisionIssuesFound,
      excessiveCoordinateValues:
        coordinatePrecisionValidationReport.excessiveCoordinateValues,
      coordinateRoundingCollisions:
        coordinatePrecisionValidationReport.roundingCollisions,
      unsafeCoordinateMagnitudeValues:
        coordinatePrecisionValidationReport.unsafeMagnitudeValues,
      coordinatePrecisionIssuesUnresolved:
        coordinatePrecisionValidationReport.unresolvedIssues,
      coordinatePrecisionValidationReport,
      appliedCoordinatePrecision: 9,
      appliedTolerance: usertolerance,
      appliedOverlapThresholdRatio: effectiveOverlapRatio,
      appliedNearDuplicateMaxOffsetMeters:
        effectiveNearDuplicateMaxOffsetMeters,
      appliedNearDuplicateMinIoU: effectiveNearDuplicateMinIoU,
      originalSizeInBytes: size,
      optimizedSizeInBytes: newSize,
      downloadPath: `/uploads/cleaned_files/${outputFileName}`,
      outputFileName,
      outputFilePath,
    };
  },
  { connection: redisConnection as any, concurrency: 2 },
);

const persistLifecycle = (
  operation: Promise<unknown>,
  event: string,
  jobId: string,
): void => {
  void operation.catch((error) => {
    console.error(
      `❌ [SnapGIS Worker] Could not persist ${event} for job ${jobId}:`,
      error,
    );
  });
};

gisWorker.on("active", (job) => {
  const jobId = String(job.id);
  persistLifecycle(
    Promise.all([
      markAnalysisProcessing(jobId),
      updateUploadHealingMetrics(jobId, "processing"),
    ]),
    "active state",
    jobId,
  );
});

gisWorker.on("progress", (job, progress) => {
  const jobId = String(job.id);
  const detailedProgress = parseHealingProgress(progress);
  const numericProgress =
    detailedProgress?.value ??
    (typeof progress === "number"
      ? progress
      : typeof progress === "object" &&
          progress !== null &&
          "value" in progress &&
          typeof progress.value === "number"
        ? progress.value
        : 0);
  persistLifecycle(
    markAnalysisProgress(jobId, numericProgress),
    "progress",
    jobId,
  );
});

gisWorker.on("completed", (job, result) => {
  console.log(`✅ [SnapGIS Worker] Job ${job.id} COMPLETED.`);
  const jobId = String(job.id);
  persistLifecycle(
    (async () => {
      const analysis = await getAnalysis(jobId);
      if (analysis?.healStatus === "cancelled") return;
      await Promise.all([
        markAnalysisCompleted(jobId, result),
        updateUploadHealingMetrics(
          jobId,
          "completed",
          countAppliedRepairs(result),
        ),
      ]);
    })(),
    "completion result",
    jobId,
  );
});

gisWorker.on("failed", (job, err) => {
  console.error(`❌ [SnapGIS Worker] Job ${job?.id} FAILED: ${err.message}`);
  if (!job?.id) return;
  const maximumAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maximumAttempts) return;
  const jobId = String(job.id);
  persistLifecycle(
    (async () => {
      const analysis = await getAnalysis(jobId);
      const wasCancelled =
        analysis?.healStatus === "cancelled" ||
        (await isHealingCancellationRequested(jobId));
      if (wasCancelled) {
        await Promise.all([
          markAnalysisCancelled(jobId),
          updateUploadHealingMetrics(jobId, "cancelled", 0),
        ]);
        return;
      }
      await Promise.all([
        markAnalysisFailed(
          jobId,
          "Healing failed after all retry attempts. Please try again.",
        ),
        updateUploadHealingMetrics(jobId, "failed"),
      ]);
    })(),
    "failure state",
    jobId,
  );
});
