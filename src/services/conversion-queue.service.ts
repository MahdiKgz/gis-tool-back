import { Queue, Worker } from "bullmq";
import { redisConnection } from "./queue.service";
import {
  ConversionJobResult,
  ConversionTask,
  CONVERSION_RETENTION_SECONDS,
  processConversionJob,
} from "./conversion.service";

const QUEUE_NAME = "gis-conversion-queue";
export const conversionQueue = new Queue<
  ConversionTask,
  ConversionJobResult,
  "convert",
  ConversionTask,
  ConversionJobResult,
  "convert"
>(QUEUE_NAME, {
  // @ts-expect-error BullMQ bundles a different ioredis type version.
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: CONVERSION_RETENTION_SECONDS },
    removeOnFail: { age: CONVERSION_RETENTION_SECONDS },
  },
});
export const startConversionWorker = () =>
  new Worker<ConversionTask, ConversionJobResult>(
    QUEUE_NAME,
    (job) => processConversionJob(job.data),
    {
      // @ts-expect-error BullMQ bundles a different ioredis type version.
      connection: redisConnection,
      concurrency: 1,
    },
  );
