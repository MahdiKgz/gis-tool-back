import { UnrecoverableError } from "bullmq";
import { redisConnection } from "./queue.service";

const CANCELLATION_TTL_SECONDS = 24 * 60 * 60;
const cancellationKey = (jobId: string) => `healing:${jobId}:cancelled`;

export class HealingCancelledError extends UnrecoverableError {
  constructor() {
    super("Healing was cancelled by the user");
    this.name = "HealingCancelledError";
  }
}

export const requestHealingCancellation = async (
  jobId: string,
): Promise<void> => {
  await redisConnection.set(
    cancellationKey(jobId),
    "1",
    "EX",
    CANCELLATION_TTL_SECONDS,
  );
};

export const clearHealingCancellation = async (
  jobId: string,
): Promise<void> => {
  await redisConnection.del(cancellationKey(jobId));
};

export const isHealingCancellationRequested = async (
  jobId: string,
): Promise<boolean> =>
  (await redisConnection.exists(cancellationKey(jobId))) === 1;

export const throwIfHealingCancelled = async (jobId: string): Promise<void> => {
  if (await isHealingCancellationRequested(jobId))
    throw new HealingCancelledError();
};
