import IORedis from "ioredis";

export const authRedis = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

authRedis.on("error", (error) => {
  console.error("Redis authentication connection error:", error.message);
});

export const connectAuthRedis = async (): Promise<void> => {
  if (authRedis.status === "wait") await authRedis.connect();
  await authRedis.ping();
};
