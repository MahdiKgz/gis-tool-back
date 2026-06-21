import { Worker, Job } from "bullmq";
import { redisConnection } from "../services/queue.service";
import path from "path";
import fs from "fs";
import truncate from "@turf/truncate";
import kinks from "@turf/kinks";
import unkinkPolygon from "@turf/unkink-polygon";
import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";

interface GisJobData {
  fileName: string;
  originalName: string;
  filePath: string;
  size: number;
}

export const gisWorker = new Worker(
  "gis-processing-queue",
  async (job: Job<GisJobData>) => {
    const { fileName, originalName, filePath } = job.data;

    console.log(
      `🤖 [Worker] Processing started for Job ID: ${job.id} (${originalName})`,
    );

    if (!fs.existsSync(filePath)) {
      throw new Error(`فایل یافت نشد: ${filePath}`);
    }

    const ext = path.extname(originalName).toLowerCase();
    let geojson: any;

    await job.updateProgress(15);

    if (ext === ".kml") {
      const kmlContent = fs.readFileSync(filePath, "utf-8");
      const xmlDoc = new DOMParser().parseFromString(kmlContent, "text/xml");
      geojson = kml(xmlDoc);
    } else if (ext === ".kmz") {
      const zip = new AdmZip(filePath);
      const zipEntries = zip.getEntries();
      const kmlEntry = zipEntries.find((entry) =>
        entry.entryName.endsWith(".kml"),
      );

      if (!kmlEntry) {
        throw new Error("فایل KML معتبری درون پکیج KMZ پیدا نشد.");
      }

      const kmlContent = kmlEntry.getData().toString("utf-8");
      const xmlDoc = new DOMParser().parseFromString(kmlContent, "text/xml");
      geojson = kml(xmlDoc);
    } else {
      const rawData = fs.readFileSync(filePath, "utf-8");
      geojson = JSON.parse(rawData);
    }

    await job.updateProgress(35);

    let kinkCount = 0;
    let healedFeatures: any[] = [];

    if (geojson.type === "FeatureCollection") {
      for (const feature of geojson.features) {
        if (["Polygon", "MultiPolygon"].includes(feature.geometry?.type)) {
          const featureKinks = kinks(feature);
          if (featureKinks.features.length > 0) {
            kinkCount += featureKinks.features.length;
            const unkinked = unkinkPolygon(feature);
            healedFeatures.push(...unkinked.features);
          } else {
            healedFeatures.push(feature);
          }
        } else if (
          ["LineString", "MultiLineString"].includes(feature.geometry?.type)
        ) {
          const featureKinks = kinks(feature);
          kinkCount += featureKinks.features.length;
          healedFeatures.push(feature);
        } else {
          healedFeatures.push(feature);
        }
      }
      geojson.features = healedFeatures;
    } else {
      if (["Polygon", "MultiPolygon"].includes(geojson.geometry?.type)) {
        const featureKinks = kinks(geojson);
        if (featureKinks.features.length > 0) {
          kinkCount += featureKinks.features.length;
          geojson = unkinkPolygon(geojson);
        }
      } else if (
        ["LineString", "MultiLineString"].includes(geojson.geometry?.type)
      ) {
        const featureKinks = kinks(geojson);
        kinkCount += featureKinks.features.length;
      }
    }

    await job.updateProgress(60);

    const optimizedGeojson = truncate(geojson, {
      precision: 6,
      coordinates: 3,
    });

    await job.updateProgress(80);

    const outputDir = path.join(__dirname, "../../uploads/cleaned_files");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFileName = `cleaned-${fileName.replace(ext, ".geojson")}`;
    const outputFilePath = path.join(outputDir, outputFileName);
    fs.writeFileSync(outputFilePath, JSON.stringify(optimizedGeojson));

    const newSize = fs.statSync(outputFilePath).size;
    await job.updateProgress(100);

    return {
      success: true,
      detectedFormat: ext,
      convertedTo: "GeoJSON",
      kinksFound: kinkCount,
      healed: kinkCount > 0,
      originalSizeInBytes: job.data.size,
      optimizedSizeInBytes: newSize,
      compressionRatio: ((1 - newSize / job.data.size) * 100).toFixed(2) + "%",
      downloadPath: `/uploads/cleaned_files/${outputFileName}`,
    };
  },
  {
    connection: redisConnection as any,
    concurrency: 2,
  },
);

gisWorker.on("completed", (job) => {
  console.log(`✅ [Worker] Job ${job.id} COMPLETED SUCCESSFULLY 🎉`);
  console.log(`📊 Statistics:`, job.returnvalue);
});

gisWorker.on("failed", (job, err) => {
  console.error(`❌ [Worker] Job ${job?.id} FAILED: ${err.message}`);
});
