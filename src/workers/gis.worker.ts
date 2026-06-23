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

// --- Parsers ---
import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";
const mapshaper = require("mapshaper");

// آپدیت اینترفیس برای دریافت تلرانس به صورت میلی‌متر از سمت فرانت‌اند
interface GisJobData {
  fileName: string;
  originalName: string;
  filePath: string;
  size: number;
  tolerance?: number; // اختیاری: در صورت عدم ارسال، مقدار پیش‌فرض استفاده می‌شود
}

// تابع کمکی برای ساخت باکس جستجو (جهت افزایش شدید پرفورمنس)
const createSearchBox = (pt: any, radiusKm: number) => {
  const offset = radiusKm / 111.32; // تبدیل تقریبی کیلومتر به درجه
  const [lng, lat] = pt.geometry.coordinates;
  return bboxPolygon([lng - offset, lat - offset, lng + offset, lat + offset]);
};

// اجرای Mapshaper برای پلی‌گان‌ها
const runMapshaperPipeline = async (
  geojson: any,
  toleranceMeters: number,
): Promise<any> => {
  return new Promise((resolve, reject) => {
    const intervalDegrees = toleranceMeters / 111320;
    const commands = `-i input.json -snap interval=${intervalDegrees} -clean -o output.json format=geojson`;

    mapshaper.applyCommands(
      commands,
      { "input.json": JSON.stringify(geojson) },
      (err: any, output: any) => {
        if (err) return reject(err);
        if (!output || !output["output.json"])
          return reject(new Error("Mapshaper output missing"));
        resolve(JSON.parse(output["output.json"].toString("utf-8")));
      },
    );
  });
};

// هسته اصلی رفع خطاهای خطی (Overshoot & Undershoot)
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

    // ۱. اصلاح نرسیدگی (Undershoot) - اسنپ کردن به نزدیک‌ترین خط
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

    // ۲. اصلاح رد شدگی (Overshoot) - برش زدن اضافات از محل تقاطع
    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;

      const intersections = lineIntersect(currentLine, lines[j]);
      if (intersections.features.length > 0) {
        const lastIntersection =
          intersections.features[intersections.features.length - 1];
        // @ts-ignore
        const distToIntersection = distance(endPt, lastIntersection, {
          units: "kilometers",
        });

        if (distToIntersection > 0 && distToIntersection <= toleranceKm) {
          // @ts-ignore
          const slicedLine = lineSlice(startPt, lastIntersection, currentLine);
          coords = slicedLine.geometry.coordinates;
          modified = true;
          break;
        }
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

    // دریافت تلرانس کاداستر از فرانت، در صورت نبود، پیش‌فرض ۲۵ میلی‌متر
    const usertolerance = tolerance || 25;

    // تبدیل میلی‌متر به کیلومتر برای توابع فاصله‌سنجی Turf.js
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

    // پارس کردن فایل‌های ورودی
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

    // جداسازی عوارض
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

    // پردازش خطوط (رفع نرسیدگی و ردشدگی)
    let processedLines = featureCollection(lineFeatures);
    let healedLineCount = 0;
    if (lineFeatures.length > 0) {
      const topologicalFix = healLineTopologies(
        processedLines,
        lineToleranceKm,
      );
      processedLines = topologicalFix.geojson as any;
      healedLineCount = topologicalFix.healedCount;
    }

    await job.updateProgress(50);

    // پردازش پلی‌گان‌ها (رفع گره‌خوردگی و اجرای mapshaper)
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
    if (healedPolysList.length > 0) {
      processedPolys = await runMapshaperPipeline(
        processedPolys,
        polyToleranceMeters,
      );
    }

    await job.updateProgress(80);

    // تجمیع نهایی عوارض
    geojson.features = [
      ...processedLines.features,
      ...processedPolys.features,
      ...otherFeatures,
    ];

    // بهینه‌سازی حجم با حفظ دقت ۱ میلی‌متری (precision: 9)
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
