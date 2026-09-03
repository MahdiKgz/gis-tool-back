import { EventEmitter } from "node:events";
import { QueueEvents } from "bullmq";

export type HealingQueueEvent =
  | { type: "active" }
  | { type: "progress"; data: unknown }
  | { type: "completed"; result: unknown }
  | { type: "failed"; reason: string };

type HealingQueueEventListener = (event: HealingQueueEvent) => void;

const healingEventBus = new EventEmitter();
healingEventBus.setMaxListeners(0);
let queueEvents: QueueEvents | null = null;

const channel = (jobId: string) => `healing:${jobId}`;

const ensureQueueEvents = (): QueueEvents => {
  if (queueEvents) return queueEvents;
  queueEvents = new QueueEvents("gis-processing-queue", {
    connection: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    },
  });
  queueEvents.on("active", ({ jobId }) => {
    healingEventBus.emit(channel(jobId), { type: "active" });
  });
  queueEvents.on("progress", ({ jobId, data }) => {
    healingEventBus.emit(channel(jobId), { type: "progress", data });
  });
  queueEvents.on("completed", ({ jobId, returnvalue }) => {
    healingEventBus.emit(channel(jobId), {
      type: "completed",
      result: returnvalue,
    });
  });
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    healingEventBus.emit(channel(jobId), {
      type: "failed",
      reason: failedReason,
    });
  });
  queueEvents.on("error", (error) => {
    console.error("❌ [Queue Events] Healing event stream error:", error);
  });
  return queueEvents;
};

export const subscribeToHealingEvents = (
  jobId: string,
  listener: HealingQueueEventListener,
): (() => void) => {
  ensureQueueEvents();
  const eventChannel = channel(jobId);
  healingEventBus.on(eventChannel, listener);
  return () => healingEventBus.off(eventChannel, listener);
};

export const closeHealingEventSource = async (): Promise<void> => {
  const activeQueueEvents = queueEvents;
  queueEvents = null;
  if (activeQueueEvents) await activeQueueEvents.close();
};
