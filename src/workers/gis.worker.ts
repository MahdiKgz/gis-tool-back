import { Worker, Job } from "bullmq";
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
import bboxPolygon from "@turf/bbox-polygon";
import { point, featureCollection } from "@turf/helpers";

// [PHASE 1] — imports for flatten/collect round-trip
import flatten from "@turf/flatten";
import { featureEach, coordEach } from "@turf/meta";

// [PHASE 2] — sliver detection
import area from "@turf/area";

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
}

const createSearchBox = (pt: any, radiusKm: number) => {
  const offset = radiusKm / 111.32;
  const [lng, lat] = pt.geometry.coordinates;
  return bboxPolygon([lng - offset, lat - offset, lng + offset, lat + offset]);
};

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
): Promise<{ result: any; sliversRemovedCount: number }> => {
  return new Promise((resolve, reject) => {
    const intervalDegrees = toleranceMeters / 111320;
    const minAreaM2 = computeMinSliverAreaM2(toleranceMeters);

    // Count slivers present before Mapshaper runs
    const sliversBefore = countInputSlivers(geojson.features, minAreaM2);

    // [CHANGED] Added -filter and remove-empty after -clean to drop slivers
    // by area. Both input slivers and post-kink fragments are caught here.
    const commands = [
      `-i input.json`,
      `-snap interval=${intervalDegrees}`,
      `-clean`,
      `-filter '$.area > ${minAreaM2}' remove-empty`,
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

        // Count slivers remaining after Mapshaper to compute how many were removed
        const sliversAfter = countInputSlivers(result.features, minAreaM2);
        const sliversRemovedCount = Math.max(0, sliversBefore - sliversAfter);

        resolve({ result, sliversRemovedCount });
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
// Core topology healer — now operates only on flat LineStrings.
// Overshoot fix applied inside (findClosestIntersectionToEndpoint).
// ---------------------------------------------------------------------------
const healLineTopologies = (geojson: any, toleranceKm: number) => {
  let healedCount = 0;
  if (geojson.type !== "FeatureCollection") return { geojson, healedCount };

  let lines = geojson.features;

  for (let i = 0; i < lines.length; i++) {
    let currentLine = lines[i];
    let coords = currentLine.geometry.coordinates;
    if (coords.length < 2) continue;

    const startPt = point(coords[0]);
    const endPt = point(coords[coords.length - 1]);

    const startSearchBox = createSearchBox(startPt, toleranceKm);
    const endSearchBox = createSearchBox(endPt, toleranceKm);

    let minStartDist = Infinity,
      minEndDist = Infinity;
    let bestStartSnap = null,
      bestEndSnap = null;

    // 1. Undershoot — snap endpoints to nearest point on neighbouring lines
    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;
      const targetLine = lines[j];

      if (booleanIntersects(startSearchBox, targetLine)) {
        const snapStart = nearestPointOnLine(targetLine, startPt);
        const distStart = distance(startPt, snapStart, { units: "kilometers" });
        if (distStart < minStartDist) {
          minStartDist = distStart;
          bestStartSnap = snapStart.geometry.coordinates;
        }
      }

      if (booleanIntersects(endSearchBox, targetLine)) {
        const snapEnd = nearestPointOnLine(targetLine, endPt);
        const distEnd = distance(endPt, snapEnd, { units: "kilometers" });
        if (distEnd < minEndDist) {
          minEndDist = distEnd;
          bestEndSnap = snapEnd.geometry.coordinates;
        }
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

    // 2. Overshoot — [PHASE 1 FIX 1] use closest intersection, not last
    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;

      const intersections = lineIntersect(currentLine, lines[j]);
      if (intersections.features.length === 0) continue;

      // [CHANGED] was: intersections.features[intersections.features.length - 1]
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

// --- Worker Definition ---
export const gisWorker = new Worker(
  "gis-processing-queue",
  async (job: Job<GisJobData>) => {
    const { fileName, originalName, filePath, size, tolerance } = job.data;

    const usertolerance = tolerance || 25;
    const lineToleranceKm = usertolerance / 1000000;
    const polyToleranceMeters = usertolerance / 1000;

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

    // [PHASE 2] Pre-scan: count slivers in raw input before any processing
    const minSliverAreaM2 = computeMinSliverAreaM2(polyToleranceMeters);
    const inputSliverCount = countInputSlivers(polyFeatures, minSliverAreaM2);

    let kinkCount = 0;
    let healedPolysList: any[] = [];
    for (const feature of polyFeatures) {
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

    if (healedPolysList.length > 0) {
      // [CHANGED] runMapshaperPipeline now returns { result, sliversRemovedCount }
      const mapshaperOutput = await runMapshaperPipeline(
        processedPolys,
        polyToleranceMeters,
      );
      processedPolys = mapshaperOutput.result;
      sliversRemovedCount = mapshaperOutput.sliversRemovedCount;
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
      appliedtolerance: usertolerance,
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
