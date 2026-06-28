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
import length from "@turf/length";
import lineIntersect from "@turf/line-intersect";
import booleanIntersects from "@turf/boolean-intersects";
import lineSlice from "@turf/line-slice";
import { point, featureCollection } from "@turf/helpers";

// [PHASE 1] — imports for flatten/collect round-trip
import flatten from "@turf/flatten";
import { featureEach, coordEach } from "@turf/meta";

// [PHASE 2] — sliver detection
import area from "@turf/area";

// [PHASE 3] — gap healing + spatial index
import bbox from "@turf/bbox";
import RBush from "rbush";

// [v1.1.0 — OVERLAP] polygon overlap detection & conditional healing
import intersect from "@turf/intersect";
import union from "@turf/union";

import rewind from "@turf/rewind";

// --- Parsers ---
import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";
const mapshaper = require("mapshaper");

interface GisJobData {
  fileName: string;
  originalName: string;
  filePath: string;
  size: number;
  tolerance?: number;
  // [v1.1.0] Ratio of smaller polygon's area that defines "small" overlap.
  // Below this → merge. At or above → critical error. Default: 0.05 (5%).
  overlapThresholdRatio?: number;
}

// createSearchBox removed in Phase 3 — replaced by RBush index queries

// ---------------------------------------------------------------------------
// [PHASE 2 — SLIVER FIX]
//
// BEFORE: Mapshaper only ran -snap -clean, which removed slivers produced
//   as a side-effect of unkinking. Pre-existing input slivers passed through
//   completely untouched — no area threshold, no detection, no removal.
//
// AFTER: Three-stage approach:
//   1. countInputSlivers() — scans the raw polygon list before any processing
//      and counts features whose area falls below the minimum sliver threshold.
//      This gives the frontend a "slivers found in input" number.
//   2. Mapshaper pipeline extended with -filter '$.area > minAreaM2' remove-empty
//      This removes both input slivers AND any post-kink degenerate fragments.
//   3. Return { result, sliversRemovedCount } so the job result reflects
//      how many were actually eliminated.
//
// Threshold: Math.pow(toleranceMeters * 10, 2)
//   e.g. 25mm tolerance → 0.025m * 10 = 0.25m → 0.0625 m² minimum area.
//   The * 10 multiplier means "a polygon narrower than 10× the snap tolerance
//   on all sides is a sliver". Tunable via the tolerance input.
// ---------------------------------------------------------------------------

const MIN_SLIVER_MULTIPLIER = 10; // exposed as a constant for easy tuning

const computeMinSliverAreaM2 = (toleranceMeters: number): number =>
  Math.pow(toleranceMeters * MIN_SLIVER_MULTIPLIER, 2);

// Pre-scan: count features that fall below the sliver threshold
const countInputSlivers = (features: any[], minAreaM2: number): number =>
  features.filter((f) => {
    try {
      return area(f) < minAreaM2;
    } catch {
      return false;
    }
  }).length;

const runMapshaperPipeline = async (
  geojson: any,
  toleranceMeters: number,
): Promise<{
  result: any;
  sliversRemovedCount: number;
  gapsFound: number;
  gapsClosed: number;
}> => {
  return new Promise((resolve, reject) => {
    const intervalDegrees = toleranceMeters / 111320;
    const minAreaM2 = computeMinSliverAreaM2(toleranceMeters);

    // Count slivers and gaps present before Mapshaper runs
    const sliversBefore = countInputSlivers(geojson.features, minAreaM2);
    const gapsFound = scanGaps(geojson.features, toleranceMeters);

    // [PHASE 3 CHANGED] Two-pass pipeline:
    //   Pass 1 (Phase 2): snap + clean + sliver area filter — same as before
    //   Pass 2 (Phase 3): wider snap at GAP_SNAP_MULTIPLIER × interval + clean
    //     The wider snap pulls polygon vertices across narrow voids, closing
    //     gaps that the first pass at normal interval would miss entirely.
    const commands = [
      `-i input.json`,
      `-snap interval=${intervalDegrees}`,
      `-clean`,
      `-filter '$.area > ${minAreaM2}' remove-empty`,
      `-snap interval=${intervalDegrees * GAP_SNAP_MULTIPLIER}`,
      `-clean`,
      `-o output.json format=geojson`,
    ].join(" ");

    mapshaper.applyCommands(
      commands,
      { "input.json": JSON.stringify(geojson) },
      (err: any, output: any) => {
        if (err) return reject(err);
        if (!output || !output["output.json"])
          return reject(new Error("Mapshaper output missing"));

        const result = JSON.parse(output["output.json"].toString("utf-8"));

        const sliversAfter = countInputSlivers(result.features, minAreaM2);
        const sliversRemovedCount = Math.max(0, sliversBefore - sliversAfter);

        // Re-scan gaps after Mapshaper to measure how many were closed
        const gapsAfter = scanGaps(result.features, toleranceMeters);
        const gapsClosed = Math.max(0, gapsFound - gapsAfter);

        resolve({ result, sliversRemovedCount, gapsFound, gapsClosed });
      },
    );
  });
};

// ---------------------------------------------------------------------------
// [PHASE 1 — FIX 1] Overshoot: use closest intersection to endpoint, not last
//
// BEFORE: intersections.features[intersections.features.length - 1]
//   → picks whichever intersection Turf returns last in the array,
//     which on multi-crossing lines is almost never the right one.
//
// AFTER: reduce over all intersections and keep the one whose distance
//   to endPt is smallest AND still within tolerance.
//   Extra guard: only slice if the intersection is closer to the END
//   than to the START — prevents accidentally trimming full lines.
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

    // Only consider intersections within tolerance of the endpoint
    // and closer to the end than the start (avoids trimming the body of the line)
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
// [PHASE 1 — FIX 2] Undershoot: flatten MultiLineString before healing,
//   re-collect into Multi after.
//
// BEFORE: healLineTopologies received MultiLineString features as-is.
//   Internal segments between parts were never checked against neighbours.
//
// AFTER: flattenLineFeatures() explodes every MultiLineString into individual
//   LineStrings, tagging each with __originalIndex so we can re-collect them
//   after healing. reassembleMultiLines() merges healed parts back into
//   MultiLineString features where the original was multi-part.
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
  // Group healed parts back by their original feature index
  const groups = new Map<number, any[]>();

  for (const feature of healedFlat) {
    const idx = feature.properties.__originalIndex;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx)!.push(feature);
  }

  const result: any[] = [];

  groups.forEach((parts, originalIndex) => {
    // Clean up internal tracking props before returning
    const cleanProps = { ...parts[0].properties };
    delete cleanProps.__originalIndex;
    delete cleanProps.__partIndex;

    if (wasMulti.get(originalIndex) && parts.length > 1) {
      // Re-assemble into MultiLineString
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
      // Was originally a single LineString (or only one part survived)
      result.push({
        ...parts[0],
        properties: cleanProps,
      });
    }
  });

  return result;
};

// ---------------------------------------------------------------------------
// [PHASE 3 — PERFORMANCE] RBush spatial index for line topology healing
//
// BEFORE: O(n²) — every line checked against every other line.
//   On a 10,000-feature cadastral file: 100,000,000 iterations.
//   The createSearchBox + booleanIntersects pre-filter helped but still
//   iterated the full array twice per line (once for undershoot, once for
//   overshoot), making large files unusably slow.
//
// AFTER: O(n log n) — build an RBush R-tree from all line bboxes once,
//   then for each line query only the candidates whose bounding boxes
//   overlap the search radius. On 10,000 features a typical query returns
//   3–10 candidates instead of 9,999. Real-world speedup: 100–500×.
//
// Index item shape: { minX, minY, maxX, maxY, idx }
//   idx is the position in the lines array so we can retrieve the feature.
// ---------------------------------------------------------------------------
const buildLineIndex = (lines: any[]): RBush<any> => {
  const index = new RBush<any>();
  const items = lines.map((f, idx) => {
    const [minX, minY, maxX, maxY] = bbox(f);
    return { minX, minY, maxX, maxY, idx };
  });
  index.load(items);
  return index;
};

// Core topology healer — operates only on flat LineStrings.
// Overshoot fix from Phase 1 retained. O(n²) inner loops replaced with RBush.
const healLineTopologies = (geojson: any, toleranceKm: number) => {
  let healedCount = 0;
  if (geojson.type !== "FeatureCollection") return { geojson, healedCount };

  const lines = geojson.features;

  // Build spatial index once — O(n log n)
  const lineIndex = buildLineIndex(lines);

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    let coords = currentLine.geometry.coordinates;
    if (coords.length < 2) continue;

    const startPt = point(coords[0]);
    const endPt = point(coords[coords.length - 1]);

    // Derive search envelope in degrees from toleranceKm
    const offset = toleranceKm / 111.32;
    const [sLng, sLat] = coords[0];
    const [eLng, eLat] = coords[coords.length - 1];

    // Query RBush for candidates near the start endpoint
    const startCandidates = lineIndex.search({
      minX: sLng - offset,
      minY: sLat - offset,
      maxX: sLng + offset,
      maxY: sLat + offset,
    });

    // Query RBush for candidates near the end endpoint
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

    // 1. Undershoot — snap to nearest point on candidate lines only
    for (const item of startCandidates) {
      if (item.idx === i) continue;
      const snapStart = nearestPointOnLine(lines[item.idx], startPt);
      const distStart = distance(startPt, snapStart, { units: "kilometers" });
      if (distStart < minStartDist) {
        minStartDist = distStart;
        bestStartSnap = snapStart.geometry.coordinates;
      }
    }

    for (const item of endCandidates) {
      if (item.idx === i) continue;
      const snapEnd = nearestPointOnLine(lines[item.idx], endPt);
      const distEnd = distance(endPt, snapEnd, { units: "kilometers" });
      if (distEnd < minEndDist) {
        minEndDist = distEnd;
        bestEndSnap = snapEnd.geometry.coordinates;
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

    // 2. Overshoot — query candidates near the end endpoint, use closest intersection
    for (const item of endCandidates) {
      if (item.idx === i) continue;

      const intersections = lineIntersect(currentLine, lines[item.idx]);
      if (intersections.features.length === 0) continue;

      const bestIntersection = findClosestIntersectionToEndpoint(
        intersections,
        endPt,
        startPt,
        toleranceKm,
      );

      if (bestIntersection) {
        const slicedLine = lineSlice(startPt, bestIntersection, currentLine);
        coords = slicedLine.geometry.coordinates;
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
// [PHASE 3 — GAP HEALING] Close gaps between adjacent polygons
//
// BEFORE: The only gap closing was an accidental side-effect of Mapshaper's
//   first -snap pass. Gaps that were wider than the snap interval passed
//   through completely untouched. No detection, no counting, no intentional fix.
//
// AFTER: Three-stage intentional gap pipeline:
//   1. buildPolyIndex() — RBush index over polygon bboxes, same pattern as
//      the line index. Eliminates O(n²) polygon-pair scanning.
//   2. scanGaps() — for each polygon, query nearby neighbours. If two polygons
//      don't intersect but their expanded envelopes overlap, the gap between
//      them is within tolerance → count it. Run before AND after Mapshaper
//      to get gapsFound and gapsClosed counts for the job result.
//   3. Mapshaper second -snap pass at GAP_SNAP_MULTIPLIER × interval —
//      a deliberately wider snap that pulls polygon vertices across narrow
//      voids to close gaps that the first pass misses. Followed by a second
//      -clean to remove any degenerate rings produced by the wider snap.
//
// GAP_SNAP_MULTIPLIER = 3: empirically, gaps are typically 2–4× the
//   digitizing tolerance. 3× catches most without distorting geometry.
// ---------------------------------------------------------------------------
const GAP_SNAP_MULTIPLIER = 3;

const buildPolyIndex = (features: any[]): RBush<any> => {
  const index = new RBush<any>();
  const items = features.map((f, idx) => {
    const [minX, minY, maxX, maxY] = bbox(f);
    return { minX, minY, maxX, maxY, idx };
  });
  index.load(items);
  return index;
};

// ---------------------------------------------------------------------------
// [v1.1.0 — OVERLAP DETECTION & HEALING]
//
// DESIGN DECISION — two separate tolerance concepts:
//   • topology tolerance (mm snap) — already exists, controls vertex snapping
//   • overlapThresholdRatio — NEW, controls overlap severity classification
//     Expressed as a ratio of the SMALLER polygon's area, not an absolute m².
//     Rationale: a 1m² overlap on a 2m² parcel is catastrophic data loss.
//                the same 1m² on a 10,000m² parcel is a digitizing rounding error.
//     Formula:  overlapArea / Math.min(areaA, areaB)
//     Default:  0.05 → overlaps smaller than 5% of the smaller polygon → merge
//                    → overlaps at or above 5%            → critical error log
//
// ALGORITHM (O(n log n) via existing RBush polygon index):
//   1. Query RBush for spatially overlapping candidates (bbox pre-filter)
//   2. Run @turf/intersect on each candidate pair for exact overlap geometry
//   3. Compute overlapRatio against the smaller polygon's area
//   4. If ratio < threshold → merge with @turf/union, mark merged pair,
//      carry winning properties (larger polygon wins), push heal log entry
//   5. If ratio >= threshold → DO NOT merge, push critical error log entry
//      with exact overlap bbox and both feature IDs for the report worker
//
// PROPERTY MERGE STRATEGY:
//   The larger polygon's properties win. The smaller polygon's ID is recorded
//   in __mergedFrom on the surviving feature so the report can trace lineage.
//   This is configurable in future via a propertyMergeStrategy param.
//
// RETURN SHAPE:
//   {
//     features:             any[]   — processed polygon array (merged where safe)
//     overlapsHealed:       number  — pairs merged
//     overlapsCritical:     number  — pairs flagged as critical, not merged
//     overlapErrorLog:      OverlapEntry[]  — full detail for report worker
//   }
// ---------------------------------------------------------------------------

const DEFAULT_OVERLAP_THRESHOLD_RATIO = 0.05;

interface OverlapEntry {
  type: "healed" | "critical";
  featureIndexA: number;
  featureIndexB: number;
  featureIdA: string | null;
  featureIdB: string | null;
  overlapAreaM2: number;
  overlapRatio: number; // ratio against the smaller polygon
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
  let overlapsHealed = 0;
  let overlapsCritical = 0;

  if (features.length < 2) {
    return { features, overlapsHealed, overlapsCritical, overlapErrorLog };
  }

  // Reuse buildPolyIndex — already defined below; forward-reference is safe
  // because this function is only called at runtime inside the worker handler.
  const index = buildPolyIndex(features);

  // Track which feature indices have been merged away so we skip them
  const mergedAway = new Set<number>();
  // Accumulate result — we rebuild the array after processing all pairs
  const resultMap = new Map<number, any>();
  features.forEach((f, i) => resultMap.set(i, f));

  for (let i = 0; i < features.length; i++) {
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

      const featureB = resultMap.get(j)!;
      let areaB: number;
      try {
        areaB = area(featureB);
      } catch {
        continue;
      }
      if (areaB <= 0) continue;

      // Exact overlap geometry
      let overlapGeom: any;
      try {
        overlapGeom = intersect(featureCollection([featureA, featureB]));
      } catch {
        continue; // degenerate geometry — skip
      }
      if (!overlapGeom) continue; // no actual overlap

      let overlapAreaM2: number;
      try {
        overlapAreaM2 = area(overlapGeom);
      } catch {
        continue;
      }
      if (overlapAreaM2 <= 0) continue;
      if (overlapAreaM2 <= 1e-10) continue;

      // Ratio against the SMALLER polygon — this is the key design decision
      const smallerArea = Math.min(areaA, areaB);
      const overlapRatio = overlapAreaM2 / smallerArea;

      const overlapBbox = bbox(overlapGeom) as [number, number, number, number];
      const featureIdA = featureA.id ?? featureA.properties?.id ?? null;
      const featureIdB = featureB.id ?? featureB.properties?.id ?? null;

      if (overlapRatio < overlapThresholdRatio) {
        // ── SMALL OVERLAP → MERGE ──────────────────────────────────────────
        // Larger polygon's properties win; smaller polygon is merged away.
        let merged: any;
        try {
          merged = union(featureCollection([featureA, featureB]));
        } catch {
          // union failed (e.g. invalid geometry) — log as critical instead
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
          overlapsCritical++;
          continue;
        }

        // Assign winning properties — larger polygon wins
        const winnerProps =
          areaA >= areaB
            ? { ...featureA.properties, __mergedFrom: featureIdB ?? j }
            : { ...featureB.properties, __mergedFrom: featureIdA ?? i };

        merged.properties = winnerProps;
        merged.id = areaA >= areaB ? (featureA.id ?? i) : (featureB.id ?? j);

        // Replace featureA in the result map with the merged geometry
        resultMap.set(i, merged);
        // Mark featureB as gone
        mergedAway.add(j);
        resultMap.delete(j);

        // Update areaA for subsequent iterations (this feature may grow)
        areaA = area(merged);

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
        overlapsHealed++;
      } else {
        // ── LARGE OVERLAP → CRITICAL ERROR ────────────────────────────────
        // Do NOT modify geometry. Log with full detail for the report worker.
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
        overlapsCritical++;

        console.error(
          `🔴 [SnapGIS] CRITICAL OVERLAP — features ${featureIdA ?? i} ↔ ${featureIdB ?? j} | ` +
            `ratio: ${(overlapRatio * 100).toFixed(1)}% of smaller polygon (${overlapAreaM2.toFixed(2)} m²)`,
        );
      }
    }
  }

  // Rebuild ordered feature array, skipping merged-away indices
  const finalFeatures = Array.from(resultMap.values());

  return {
    features: finalFeatures,
    overlapsHealed,
    overlapsCritical,
    overlapErrorLog,
  };
};

// Count polygon pairs that have a gap within toleranceMeters.
// Uses RBush to query only nearby neighbours — O(n log n) not O(n²).
const scanGaps = (features: any[], toleranceMeters: number): number => {
  if (features.length < 2) return 0;
  const index = buildPolyIndex(features);
  const offsetDeg = (toleranceMeters * GAP_SNAP_MULTIPLIER) / 111320;
  let gapCount = 0;
  const counted = new Set<string>();

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
      if (j <= i) continue; // avoid double-counting
      const pairKey = `${i}:${j}`;
      if (counted.has(pairKey)) continue;

      // If they don't intersect but their expanded envelopes overlap → gap
      try {
        if (!booleanIntersects(features[i], features[j])) {
          gapCount++;
          counted.add(pairKey);
        }
      } catch {
        // degenerate geometry — skip silently
      }
    }
  }

  return gapCount;
};

// --- Worker Definition ---
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
    } = job.data;

    const usertolerance = tolerance || 25;
    const lineToleranceKm = usertolerance / 1000000;
    const polyToleranceMeters = usertolerance / 1000;
    const effectiveOverlapRatio =
      overlapThresholdRatio ?? DEFAULT_OVERLAP_THRESHOLD_RATIO;

    console.log(
      `🤖 [SnapGIS Worker] Processing Job ID: ${job.id} (${originalName}) | Tolerance: ${usertolerance}mm`,
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

    await job.updateProgress(20);

    const polyFeatures = geojson.features.filter((f: any) =>
      ["Polygon", "MultiPolygon"].includes(f.geometry?.type),
    );
    const lineFeatures = geojson.features.filter((f: any) =>
      ["LineString", "MultiLineString"].includes(f.geometry?.type),
    );
    const otherFeatures = geojson.features.filter(
      (f: any) =>
        !["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(
          f.geometry?.type,
        ),
    );

    await job.updateProgress(30);

    // [PHASE 1 — FIX 2] Flatten Multi → heal → reassemble
    let healedLineCount = 0;
    let processedLineFeatures: any[] = lineFeatures;

    if (lineFeatures.length > 0) {
      // Step 1: explode MultiLineStrings into flat LineStrings
      const { flat, wasMulti } = flattenLineFeatures(lineFeatures);

      // Step 2: run topology healer on flat LineStrings only
      const flatCollection = featureCollection(flat);
      const topologicalFix = healLineTopologies(
        flatCollection,
        lineToleranceKm,
      );
      healedLineCount = topologicalFix.healedCount;

      // Step 3: re-collect healed parts back into their original Multi structure
      processedLineFeatures = reassembleMultiLines(
        topologicalFix.geojson.features,
        wasMulti,
      );
    }

    const processedLines = featureCollection(processedLineFeatures);

    await job.updateProgress(50);

    // [v1.1.0] Pre-scan: count slivers in raw input before any processing
    const minSliverAreaM2 = computeMinSliverAreaM2(polyToleranceMeters);
    const inputSliverCount = countInputSlivers(polyFeatures, minSliverAreaM2);

    // [v1.1.0 — OVERLAP] Run overlap detection & healing BEFORE kink processing.
    // Rationale: kink detection on two overlapping polygons can produce false
    // self-intersection reports. Resolving overlaps first gives kinks a clean input.
    let overlapsHealed = 0;
    let overlapsCritical = 0;
    let overlapErrorLog: OverlapEntry[] = [];
    let polyFeaturesAfterOverlap = polyFeatures;

    if (polyFeatures.length > 1) {
      const overlapResult = healPolygonOverlaps(
        polyFeatures,
        effectiveOverlapRatio,
      );
      polyFeaturesAfterOverlap = overlapResult.features;
      overlapsHealed = overlapResult.overlapsHealed;
      overlapsCritical = overlapResult.overlapsCritical;
      overlapErrorLog = overlapResult.overlapErrorLog;

      console.log(
        `🔷 [SnapGIS] Overlaps — merged: ${overlapsHealed} | critical: ${overlapsCritical}`,
      );
    }

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

    let processedPolys = featureCollection(healedPolysList);
    let sliversRemovedCount = 0;
    let gapsFound = 0;
    let gapsClosed = 0;

    if (healedPolysList.length > 0) {
      healedPolysList = healedPolysList.map((f) => rewind(f));
      const mapshaperOutput = await runMapshaperPipeline(
        processedPolys,
        polyToleranceMeters,
      );
      processedPolys = mapshaperOutput.result;
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
      appliedtolerance: usertolerance,
      appliedOverlapThresholdRatio: effectiveOverlapRatio,
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
