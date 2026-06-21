import { Worker, Job } from "bullmq";
import { redisConnection } from "../services/queue.service";
import path from "path";
import fs from "fs";
import truncate from "@turf/truncate";
import kinks from "@turf/kinks";

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
    const rawData = fs.readFileSync(filePath, "utf-8");
    const geojson = JSON.parse(rawData);

    await job.updateProgress(20);

    console.log(`⏳ [Worker] Job ${job.id}: Checking for geometry kinks...`);

    let kinkCount = 0;
    const allowedTypes = [
      "LineString",
      "MultiLineString",
      "Polygon",
      "MultiPolygon",
    ];

    if (geojson.type === "FeatureCollection") {
      for (const feature of geojson.features) {
        if (allowedTypes.includes(feature.geometry?.type)) {
          const featureKinks = kinks(feature);
          kinkCount += featureKinks.features.length;
        }
      }
    } else if (allowedTypes.includes(geojson.geometry?.type || geojson.type)) {
      const featureKinks = kinks(geojson);
      kinkCount = featureKinks.features.length;
    }

    await job.updateProgress(50);

    console.log(
      `⏳ [Worker] Job ${job.id}: Truncating coordinates to 6 decimals...`,
    );
    const optimizedGeojson = truncate(geojson, {
      precision: 6,
      coordinates: 3,
    });

    await job.updateProgress(80);

    const outputDir = path.join(__dirname, "../../uploads/cleaned_files");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFilePath = path.join(outputDir, `cleaned-${fileName}`);
    fs.writeFileSync(outputFilePath, JSON.stringify(optimizedGeojson));

    const newSize = fs.statSync(outputFilePath).size;
    await job.updateProgress(100);

    return {
      success: true,
      kinksFound: kinkCount,
      originalSizeInBytes: job.data.size,
      optimizedSizeInBytes: newSize,
      compressionRatio: ((1 - newSize / job.data.size) * 100).toFixed(2) + "%",
      downloadPath: `/uploads/cleaned_files/cleaned-${fileName}`,
    };
  },
  {
    // @ts-expect-error type for connection
    connection: redisConnection,
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
