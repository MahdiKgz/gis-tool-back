import { EventEmitter } from "node:events";
import { QueueEvents } from "bullmq";
import IORedis from "ioredis";

export type HealingQueueEventPayload =
  | { type: "snapshot"; data: unknown }
  | { type: "active" }
  | { type: "progress"; data: unknown }
  | { type: "completed"; result: unknown }
  | { type: "failed"; reason: string }
  | { type: "cancelled"; reason: string }
  | { type: "stream-error"; data: unknown };

export type HealingQueueEvent = HealingQueueEventPayload & { id: string };

export interface StoredHealingEvent {
  id: string;
  event: HealingQueueEventPayload;
}

type HealingQueueEventListener = (event: HealingQueueEvent) => void;

const EVENT_HISTORY_LIMIT = 100;
const EVENT_HISTORY_TTL_SECONDS = 24 * 60 * 60;
const healingEventBus = new EventEmitter();
healingEventBus.setMaxListeners(0);
const publishChains = new Map<string, Promise<void>>();
let queueEvents: QueueEvents | null = null;
let historyRedis: IORedis | null = null;

const channel = (jobId: string) => `healing:${jobId}`;
const sequenceKey = (jobId: string) => `healing:${jobId}:event-sequence`;
const historyKey = (jobId: string) => `healing:${jobId}:event-history`;

const getHistoryRedis = (): IORedis => {
  if (historyRedis) return historyRedis;
  historyRedis = new IORedis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });
  return historyRedis;
};

const persistEvent = async (
  jobId: string,
  event: HealingQueueEventPayload,
): Promise<HealingQueueEvent> => {
  const redis = getHistoryRedis();
  const id = String(await redis.incr(sequenceKey(jobId)));
  const record: StoredHealingEvent = { id, event };
  await redis
    .multi()
    .rpush(historyKey(jobId), JSON.stringify(record))
    .ltrim(historyKey(jobId), -EVENT_HISTORY_LIMIT, -1)
    .expire(historyKey(jobId), EVENT_HISTORY_TTL_SECONDS)
    .expire(sequenceKey(jobId), EVENT_HISTORY_TTL_SECONDS)
    .exec();
  return { ...event, id };
};

export const storeHealingEvent = persistEvent;

export const publishHealingEvent = (
  jobId: string,
  event: HealingQueueEventPayload,
): Promise<void> => {
  const previous = publishChains.get(jobId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const stored = await persistEvent(jobId, event);
      healingEventBus.emit(channel(jobId), stored);
    });
  publishChains.set(jobId, current);
  return current.finally(() => {
    if (publishChains.get(jobId) === current) publishChains.delete(jobId);
  });
};

export const getHealingEventsAfter = async (
  jobId: string,
  lastEventId: string,
): Promise<HealingQueueEvent[]> => {
  if (!/^\d+$/.test(lastEventId)) return [];
  const lastId = BigInt(lastEventId);
  const records = await getHistoryRedis().lrange(historyKey(jobId), 0, -1);
  return records.flatMap((serialized) => {
    try {
      const record = JSON.parse(serialized) as StoredHealingEvent;
      if (!record.id || !record.event || BigInt(record.id) <= lastId) return [];
      return [{ ...record.event, id: record.id } as HealingQueueEvent];
    } catch {
      return [];
    }
  });
};

const queuePublish = (jobId: string, event: HealingQueueEventPayload): void => {
  void publishHealingEvent(jobId, event).catch((error) => {
    console.error(`Could not persist healing event for ${jobId}:`, error);
  });
};

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
  queueEvents.on("active", ({ jobId }) =>
    queuePublish(jobId, { type: "active" }),
  );
  queueEvents.on("progress", ({ jobId, data }) =>
    queuePublish(jobId, { type: "progress", data }),
  );
  queueEvents.on("completed", ({ jobId, returnvalue }) =>
    queuePublish(jobId, { type: "completed", result: returnvalue }),
  );
  queueEvents.on("failed", ({ jobId, failedReason }) =>
    queuePublish(jobId, { type: "failed", reason: failedReason }),
  );
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
  const activeHistoryRedis = historyRedis;
  queueEvents = null;
  historyRedis = null;
  await Promise.allSettled([
    ...(activeQueueEvents ? [activeQueueEvents.close()] : []),
    ...(activeHistoryRedis ? [activeHistoryRedis.quit()] : []),
  ]);
};
