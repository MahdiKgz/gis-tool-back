import { Queue, Worker } from "bullmq";
import { database } from "./database.service";
import { redisConnection } from "./queue.service";
import { failSpatialImage, processSpatialImage } from "./spatial-image-processor.service";

const QUEUE_NAME = "gis-spatial-images";
type ImageJob = { id: string };

export const startSpatialImageWorker = () => {
  const queue = new Queue<ImageJob, void, "prepare", ImageJob, void, "prepare">(QUEUE_NAME, {
    // @ts-expect-error BullMQ bundles a different ioredis type version.
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 2, backoff: { type: "fixed", delay: 10000 },
      removeOnComplete: true, removeOnFail: { age: 86400 },
    },
  });
  const worker = new Worker<ImageJob>(QUEUE_NAME, (job) => processSpatialImage(job.data.id), {
    // @ts-expect-error BullMQ bundles a different ioredis type version.
    connection: redisConnection,
    concurrency: 1,
  });
  worker.on("error", (error) => console.error("Spatial image worker unavailable", error));
  worker.on("failed", (job, error) => {
    console.error("Spatial image processing failed", job?.id, error);
  });
  queue.on("error", (error) => console.error("Spatial image queue unavailable", error));

  // Persist the completion request in PostgreSQL before scheduling. The next scan
  // recovers work after a restart or a failed Redis write.
  let scan: Promise<void> | undefined;
  const reconcile = async () => {
    const pending = await database.spatialImage.findMany({
      where: { status: "processing" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    for (const { id } of pending) {
      const job = await queue.getJob(id);
      if (!job) await queue.add("prepare", { id }, { jobId: id });
      else if (await job.isFailed()) await failSpatialImage(id, "IMAGE_PROCESSING_FAILED");
    }
  };
  const schedule = () => {
    scan ??= reconcile()
      .catch((error) => console.error("Spatial image scheduling failed", error))
      .finally(() => { scan = undefined; });
  };
  schedule();
  const timer = setInterval(schedule, 5000);
  return {
    close: async () => {
      clearInterval(timer);
      await scan;
      await Promise.all([worker.close(), queue.close()]);
    },
  };
};
