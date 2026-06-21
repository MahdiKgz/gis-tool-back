import { Worker, Job } from "bullmq";
import { redisConnection } from "../services/queue.service";
import path from "path";
import fs from "fs";
import truncate from "@turf/truncate";
import kinks from "@turf/kinks";
import unkinkPolygon from "@turf/unkink-polygon";
import distance from "@turf/distance";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import length from "@turf/length";
import bbox from "@turf/bbox";
import { point } from "@turf/helpers";
import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";

interface GisJobData {
  fileName: string;
  originalName: string;
  filePath: string;
  size: number;
}

// ============================================================================
// ۱. موتور تشخیص مقیاس و محاسبه اتوماتیک تلورانس
// ============================================================================
const calculateDynamicToleranceKm = (geojson: any): number => {
  const fileBbox = bbox(geojson);
  const p1 = point([fileBbox[0], fileBbox[1]]);
  const p2 = point([fileBbox[2], fileBbox[3]]);
  const fileSpanKm = distance(p1, p2, { units: "kilometers" });

  let toleranceKm = 0.001; // پیش‌فرض: ۱ متر

  if (fileSpanKm < 1) {
    // مقیاس خرد (Micro): املاک و پارسل‌های کوچک -> ۵۰ سانتی‌متر
    toleranceKm = 0.0005;
  } else if (fileSpanKm >= 1 && fileSpanKm <= 50) {
    // مقیاس شهری (Urban): -> ۱ متر
    toleranceKm = 0.001;
  } else {
    // مقیاس کلان (Macro): استانی یا کشوری -> ۵ متر
    toleranceKm = 0.005;
  }

  return toleranceKm;
};

// ============================================================================
// ۲. جراح اسلایورها و گپ‌ها با استفاده از استخر پیش‌رونده (Progressive Pool)
// ============================================================================
const healSliversAndGaps = (geojson: any, toleranceKm: number) => {
  if (geojson.type !== "FeatureCollection") return geojson;

  // مرتب‌سازی بر اساس اولویت (اولویت بالاتر، مرجع و ثابت می‌ماند)
  const sortedFeatures = [...geojson.features].sort((a, b) => {
    const priorityA = a.properties?.priority || 0;
    const priorityB = b.properties?.priority || 0;
    return priorityB - priorityA;
  });

  // استخر مختصات در ابتدا خالی است
  const vertexPool: { coords: [number, number]; featureId: string }[] = [];

  sortedFeatures.forEach((f: any, index: number) => {
    const fId = f.properties?.id || `feature_${index}`;
    let snappedCount = 0;

    // ۱. ابتدا سعی می‌کنیم نقاط این فیچر را به نقاط موجود در استخر بچسبانیم
    const snap = (coords: any): any => {
      if (typeof coords[0] === "number") {
        const pt = point(coords);

        for (const item of vertexPool) {
          const refPt = point(item.coords);
          const dist = distance(pt, refPt, { units: "kilometers" });

          // اگر نزدیک بود، دقیقاً به همان گره قفل می‌شود
          if (dist <= toleranceKm) {
            snappedCount++;
            return [item.coords[0], item.coords[1]];
          }
        }
        return coords; // اگر نقطه‌ای نزدیک نبود، خودش برمی‌گردد
      }
      return coords.map(snap);
    };

    if (f.geometry?.coordinates) {
      f.geometry.coordinates = snap(f.geometry.coordinates);
      if (!f.properties) f.properties = {};
      f.properties._snappedNodes = snappedCount;
    }

    // ۲. بعد از اتمام اسنپینگِ این فیچر، حالا نقاطش را به استخر اضافه می‌کنیم
    // تا فیچرهای بعدی (کم‌اولویت‌تر) بتوانند به این شکلِ جدید بچسبند
    const collect = (coords: any) => {
      if (typeof coords[0] === "number") {
        vertexPool.push({ coords: [coords[0], coords[1]], featureId: fId });
      } else {
        coords.forEach(collect);
      }
    };

    if (f.geometry?.coordinates) {
      collect(f.geometry.coordinates);
    }
  });

  geojson.features = sortedFeatures;
  return geojson;
};
const healLineTopologies = (geojson: any, toleranceKm: number = 0.001) => {
  let healedCount = 0;
  if (geojson.type !== "FeatureCollection") return { geojson, healedCount };

  const lines = geojson.features.filter((f: any) =>
    ["LineString", "MultiLineString"].includes(f.geometry?.type),
  );

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    if (currentLine.geometry.type !== "LineString") continue;

    let coords = currentLine.geometry.coordinates;
    if (coords.length < 2) continue;

    const lineLen = length(currentLine, { units: "kilometers" });
    if (lineLen > 0 && lineLen < toleranceKm) {
      currentLine.properties = {
        ...currentLine.properties,
        _isOvershoot: true,
      };
      healedCount++;
      continue;
    }

    const startPt = point(coords[0]);
    const endPt = point(coords[coords.length - 1]);
    let minStartDist = Infinity,
      minEndDist = Infinity;
    let bestStartSnap = null,
      bestEndSnap = null;

    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;
      const targetLine = lines[j];
      if (targetLine.geometry.type !== "LineString") continue;

      const snapStart = nearestPointOnLine(targetLine, startPt);
      const distStart = distance(startPt, snapStart, { units: "kilometers" });
      if (distStart < minStartDist) {
        minStartDist = distStart;
        bestStartSnap = snapStart.geometry.coordinates;
      }

      const snapEnd = nearestPointOnLine(targetLine, endPt);
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

    if (modified) {
      currentLine.geometry.coordinates = coords;
      healedCount++;
    }
  }

  geojson.features = geojson.features.filter(
    (f: any) => !f.properties?._isOvershoot,
  );
  return { geojson, healedCount };
};

// ============================================================================
// 🚀 هسته اصلی پردازش (BullMQ Worker)
// ============================================================================
export const gisWorker = new Worker(
  "gis-processing-queue",
  async (job: Job<GisJobData>) => {
    const { fileName, originalName, filePath } = job.data;
    console.log(
      `🤖 [Worker] Processing started for Job ID: ${job.id} (${originalName})`,
    );

    if (!fs.existsSync(filePath)) throw new Error(`فایل یافت نشد: ${filePath}`);
    const ext = path.extname(originalName).toLowerCase();
    let geojson: any;

    await job.updateProgress(10);

    // --- مرحله ۱: پارس کردن فایل ورودی ---
    if (ext === ".kml") {
      const kmlContent = fs.readFileSync(filePath, "utf-8");
      const xmlDoc = new DOMParser().parseFromString(kmlContent, "text/xml");
      geojson = kml(xmlDoc);
    } else if (ext === ".kmz") {
      const zip = new AdmZip(filePath);
      const kmlEntry = zip
        .getEntries()
        .find((e) => e.entryName.endsWith(".kml"));
      if (!kmlEntry) throw new Error("فایل KML یافت نشد.");
      const xmlDoc = new DOMParser().parseFromString(
        kmlEntry.getData().toString("utf-8"),
        "text/xml",
      );
      geojson = kml(xmlDoc);
    } else {
      geojson = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }

    await job.updateProgress(30);

    // --- مرحله ۲: جراحی گره‌های درونی (Kinks) ---
    console.log(`⏳ [Worker] Job ${job.id}: Healing Polygon Kinks...`);
    let kinkCount = 0;
    let healedFeatures: any[] = [];
    if (geojson.type === "FeatureCollection") {
      for (const feature of geojson.features) {
        if (["Polygon", "MultiPolygon"].includes(feature.geometry?.type)) {
          const featureKinks = kinks(feature);
          if (featureKinks.features.length > 0) {
            kinkCount += featureKinks.features.length;
            healedFeatures.push(...unkinkPolygon(feature).features);
          } else {
            healedFeatures.push(feature);
          }
        } else {
          healedFeatures.push(feature);
        }
      }
      geojson.features = healedFeatures;
    }

    await job.updateProgress(50);

    // --- مرحله ۳: ترمیم خطوط (Undershoot / Overshoot) ---
    console.log(
      `⏳ [Worker] Job ${job.id}: Healing Undershoots and Overshoots...`,
    );
    const topologicalFix = healLineTopologies(geojson, 0.001);
    geojson = topologicalFix.geojson;

    await job.updateProgress(65);

    // --- مرحله ۴: محاسبه اتوماتیک مقیاس و درمان اسلایورها/گپ‌ها ---
    console.log(
      `⏳ [Worker] Job ${job.id}: Resolving Relational Gaps & Slivers...`,
    );
    const autoToleranceKm = calculateDynamicToleranceKm(geojson);
    console.log(
      `🧲 [Worker] Job ${job.id}: Applied Auto-Tolerance: ${autoToleranceKm * 1000}m`,
    );

    geojson = healSliversAndGaps(geojson, autoToleranceKm);

    await job.updateProgress(85);

    // --- مرحله ۵: استانداردسازی و فشرده‌سازی ممیزها ---
    const optimizedGeojson = truncate(geojson, {
      precision: 6,
      coordinates: 3,
    });

    // --- مرحله ۶: ذخیره‌سازی در دیسک ---
    const outputDir = path.join(__dirname, "../../uploads/cleaned_files");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFileName = `cleaned-${fileName.replace(ext, ".geojson")}`;
    const outputFilePath = path.join(outputDir, outputFileName);
    fs.writeFileSync(outputFilePath, JSON.stringify(optimizedGeojson));

    const newSize = fs.statSync(outputFilePath).size;
    await job.updateProgress(100);

    return {
      success: true,
      detectedFormat: ext,
      kinksFound: kinkCount,
      healedUndershootOvershoot: topologicalFix.healedCount,
      appliedToleranceMeters: autoToleranceKm * 1000,
      originalSizeInBytes: job.data.size,
      optimizedSizeInBytes: newSize,
      compressionRatio: ((1 - newSize / job.data.size) * 100).toFixed(2) + "%",
      downloadPath: `/uploads/cleaned_files/${outputFileName}`,
    };
  },
  { connection: redisConnection as any, concurrency: 2 },
);

gisWorker.on("completed", (job) => {
  console.log(`✅ [Worker] Job ${job.id} COMPLETED SUCCESSFULLY 🎉`);
  console.log(`📊 Statistics:`, job.returnvalue);
});

gisWorker.on("failed", (job, err) => {
  console.error(`❌ [Worker] Job ${job?.id} FAILED: ${err.message}`);
});
