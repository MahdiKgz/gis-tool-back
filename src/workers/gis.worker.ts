// @ts-nocheck
import os from "node:os";
import { isObjectReference, storedStat, objectKey, putStoredFile, removeStoredFile } from "../services/object-storage.service";
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
import { processNeighborConsistency } from "../processing/neighbor-consistency";
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
import { isParcelType, manualReviewGroupIds } from "../services/manual-parcel.service";
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
import { cadLayer } from "../processing/shared/cad-layer";
import { subtractSharedPolygonAreas } from "../processing/overlaps/repair";

const sourceParcelIndex = Symbol("sourceParcelIndex");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// [DUPLICATE DETECTION] Constants
// ---------------------------------------------------------------------------
// Tolerance for "identical" bbox/coordinate comparisons — this exists purely
// to absorb floating-point serialization noise (e.g. a value written as
// 51.39000000000001 vs 51.39), NOT to represent any real-world distance.
// ~1e-9 degrees is sub-millimetre at any latitude.
const EXACT_MATCH_EPSILON_DEG = 1e-9;

// Default near-duplicate gates. Both are independent of snap tolerance —
// duplicate severity and
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

  // Candidate geometry remains fixed throughout duplicate detection.
  const index = buildIndex(features);
  const removed = new Set<number>();
  const layers = features.map(cadLayer);

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
      if (j <= i || removed.has(j) || layers[i] !== layers[j]) continue;

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
      nearDuplicateMaxOffsetMeters,
      nearDuplicateMinIoU,
    } = job.data;

    const usertolerance = tolerance || 25;
    const polyToleranceMeters = usertolerance / 1000;
    const minSliverAreaM2 = computeSliverAreaThresholdM2(polyToleranceMeters);
    const effectiveNearDuplicateMaxOffsetMeters =
      nearDuplicateMaxOffsetMeters ?? DEFAULT_NEAR_DUPLICATE_MAX_OFFSET_M;
    const effectiveNearDuplicateMinIoU =
      nearDuplicateMinIoU ?? DEFAULT_NEAR_DUPLICATE_MIN_IOU;

    console.log(
      `🤖 [SnapGIS Worker] Job ${job.id} | ${originalName} ` +
        `| tolerance: ${usertolerance}mm`,
    );

    await cancellationCheckpoint();

    await storedStat(filePath);

    const ext = path.extname(originalName).toLowerCase();
    await job.updateProgress(createHealingProgress(10, "parsing"));
    let geojson: any = await readGisFile(filePath, originalName);
    const analysis = await getAnalysis(jobId);
    for (const group of analysis?.report.issueGroups ?? []) {
      if (group.code !== "POLYGON_OVERLAP") continue;
      for (const index of group.affectedFeatureIndexes) {
        if (geojson.features?.[index]) geojson.features[index][sourceParcelIndex] = index;
      }
    }
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

    // Keep review targets out of stages that can merge or remove their output slot.
    const unsafePolygons = new Set(quarantinedFeatureIndexes);
    const confirmedParcels = new Set(Object.keys(analysis?.parcelEdits ?? {}).map(Number));
    const manualParcelIndexes = new Set<number>();
    const reviewGroups = analysis ? manualReviewGroupIds(analysis) : new Set<string>();
    for (const group of analysis?.report.issueGroups ?? []) {
      if (!reviewGroups.has(group.groupId)) continue;
      for (const index of group.affectedFeatureIndexes) {
        if (isParcelType(geojson.features[index]?.geometry?.type)) {
          manualParcelIndexes.add(index);
          quarantinedFeatureIndexes.add(index);
        }
      }
    }
    for (const index of confirmedParcels) {
      manualParcelIndexes.add(index);
      quarantinedFeatureIndexes.add(index);
    }
    const quarantinedFeatures: any[] = [];
    const reviewOverlapOffsets: number[] = [];
    const manualParcelOffsets: Array<[number, number]> = [];
    geojson.features.forEach((feature: any, index: number) => {
      if (!quarantinedFeatureIndexes.has(index)) return;
      if (manualParcelIndexes.has(index)) {
        manualParcelOffsets.push([index, quarantinedFeatures.length]);
      }
      if (!unsafePolygons.has(index) && !confirmedParcels.has(index) &&
          isParcelType(feature.geometry?.type)) {
        reviewOverlapOffsets.push(quarantinedFeatures.length);
      }
      quarantinedFeatures.push(feature);
    });

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

    await job.updateProgress(
      createHealingProgress(50, "healing", {
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    const kinkCount =
      selfIntersectionValidationReport.selfIntersectionsFound;
    const healedPolysList: any[] = polyFeaturesAfterDuplicates;

    await job.updateProgress(
      createHealingProgress(60, "healing", {
        kink: kinkCount,
        sliver: inputSliverCount,
        spike: spikeValidationReport.spikesFound,
      }),
    );
    await cancellationCheckpoint();

    let processedPolys = featureCollection([] as any[]);
    let sliversRemovedCount = 0;
    let sliversAbsorbedCount = 0;
    let sliversDeletedCount = 0;
    let sliverRepairValidationReport: any = null;
    let gapsFound = 0;
    let gapsClosed = 0;
    let gapValidationReport: any = null;
    let neighborVerticesInserted = 0;
    let neighborConsistencyValidationReport: any = null;
    let postProcessingRingsOrientationNormalized = 0;
    let postProcessingRingOrientationIssuesUnresolved = 0;

    if (healedPolysList.length > 0) {
      const oriented = processRingOrientation(featureCollection(healedPolysList)).geojson;
      const slivers = processSlivers(oriented, { sliverAreaThresholdM2: minSliverAreaM2 }, true);
      const gaps = processGaps(slivers.geojson, {
        gapToleranceMeters: computeGapToleranceMeters(polyToleranceMeters),
        minimumGapWidthMeters: polyToleranceMeters,
      }, true);
      processedPolys = gaps.geojson;
      sliversRemovedCount = slivers.report.sliversRemoved;
      sliversAbsorbedCount = slivers.report.sliversAbsorbed;
      sliversDeletedCount = slivers.report.sliversDeleted;
      sliverRepairValidationReport = slivers.report;
      gapsFound = gaps.report.gapsFound;
      gapsClosed = gaps.report.gapsRepaired;
      gapValidationReport = gaps.report;
    }

    // Subtract after gap repair so the intentionally cleared overlap is not filled again.
    const regularCount = processedPolys.features.length;
    const { features: clippedPolygons, removedFeatureIndexes, overlapsHealed, overlapsCritical, overlapErrorLog } =
      subtractSharedPolygonAreas([
        ...processedPolys.features,
        ...reviewOverlapOffsets.map((offset) => quarantinedFeatures[offset]),
      ]);
    const outputOrientation = processRingOrientation(featureCollection(clippedPolygons));
    const removedQuarantineOffsets = new Set<number>();
    for (const [index, offset] of reviewOverlapOffsets.entries()) {
      const clippedIndex = regularCount + index;
      if (removedFeatureIndexes.has(clippedIndex)) removedQuarantineOffsets.add(offset);
      else quarantinedFeatures[offset] = outputOrientation.geojson.features[clippedIndex];
    }
    processedPolys = featureCollection(outputOrientation.geojson.features.slice(0, regularCount)
      .filter((_, index) => !removedFeatureIndexes.has(index)));
    postProcessingRingsOrientationNormalized = outputOrientation.report.ringsNormalized;
    postProcessingRingOrientationIssuesUnresolved = outputOrientation.report.unresolvedIssues;

    // Synchronize segmentation only after every shape-changing polygon stage.
    // Inserting a proven collinear vertex leaves the final boundary and area
    // unchanged while preventing hidden T-nodes in subsequent edits/exports.
    const neighborConsistencyResult = processNeighborConsistency(
      processedPolys,
      {},
      true,
    );
    processedPolys = neighborConsistencyResult.geojson;
    neighborConsistencyValidationReport = neighborConsistencyResult.report;
    neighborVerticesInserted =
      neighborConsistencyValidationReport.verticesInserted;

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

    const manualParcelOutputIndexes = Object.fromEntries(
      geojson.features.flatMap((feature, index) =>
        feature[sourceParcelIndex] === undefined ? [] : [[feature[sourceParcelIndex], index]]),
    );
    const manualIndexesByOffset = new Map(manualParcelOffsets.map(([index, offset]) => [offset, index]));
    const keptQuarantine: any[] = [];
    quarantinedFeatures.forEach((feature, offset) => {
      if (removedQuarantineOffsets.has(offset)) return;
      const index = manualIndexesByOffset.get(offset);
      if (index !== undefined) manualParcelOutputIndexes[index] = geojson.features.length + keptQuarantine.length;
      keptQuarantine.push(feature);
    });
    const optimizedGeojson = prepareOutputCoordinates(geojson, 9);
    optimizedGeojson.features = optimizedGeojson.features.concat(keptQuarantine);

    const remote = isObjectReference(filePath);
    const outputDir = remote ? fs.mkdtempSync(path.join(os.tmpdir(), "snapgis-healing-")) : path.join(__dirname, "../../uploads/cleaned_files");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFileName = `cleaned-${fileName.replace(ext, ".geojson")}`;
    let outputFilePath = path.join(outputDir, outputFileName);
    let newSize: number;
    try {
      await cancellationCheckpoint();
      fs.writeFileSync(outputFilePath, JSON.stringify(optimizedGeojson));

      if (await isHealingCancellationRequested(jobId)) {
        fs.rmSync(outputFilePath, { force: true });
        await cancellationCheckpoint();
      }

      newSize = fs.statSync(outputFilePath).size;
      if (remote) {
        if (!job.data.ownerId) throw new Error('Object storage job has no owner');
        outputFilePath = await putStoredFile(objectKey(job.data.ownerId, jobId, 'healed', outputFileName), outputFilePath, 'application/geo+json');
        if (await isHealingCancellationRequested(jobId)) {
          await removeStoredFile(outputFilePath);
          await cancellationCheckpoint();
        }
      }
    } finally { if (remote) fs.rmSync(outputDir, { recursive: true, force: true }); }
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
      neighborVerticesInserted,
      neighborConsistencyValidationReport,
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
      appliedNearDuplicateMaxOffsetMeters:
        effectiveNearDuplicateMaxOffsetMeters,
      appliedNearDuplicateMinIoU: effectiveNearDuplicateMinIoU,
      originalSizeInBytes: size,
      optimizedSizeInBytes: newSize,
      downloadPath: `/api/heal/${jobId}/download`,
      outputFileName,
      outputFilePath,
      manualParcelOutputIndexes,
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
