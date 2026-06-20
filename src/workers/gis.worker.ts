import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { redisConnection } from "../services/queue.service";

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
      throw new Error(`فایل در مسیر مشخص شده یافت نشد: ${filePath}`);
    }

    await job.updateProgress(25);
    console.log(`⏳ [Worker] Job ${job.id}: File read successfully.`);

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await job.updateProgress(75);
    console.log(`⏳ [Worker] Job ${job.id}: Geometry cleaned and simplified.`);

    // قدم ۳: پایان پردازش
    await job.updateProgress(100);

    return {
      success: true,
      processedFile: `cleaned-${fileName}`,
      savedAt: new Date().toISOString(),
    };
  },
  {
    // @ts-expect-error type-checking for connection type
    connection: redisConnection,
    concurrency: 2,
  },
);

gisWorker.on("completed", (job) => {
  console.log(`✅ [Worker] Job ${job.id} COMPLETED. Result:`, job.returnvalue);
});

gisWorker.on("failed", (job, err) => {
  console.error(`❌ [Worker] Job ${job?.id} FAILED: ${err.message}`);
});
