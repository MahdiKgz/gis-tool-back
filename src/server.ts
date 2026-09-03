import "dotenv/config";
import app from "./app";
import { initCleanupCron } from "./services/cleanup.service";
import { connectAuthRedis, authRedis } from "./services/auth-redis.service";
import { database, initializeDatabase } from "./services/database.service";
import { getAccessTokenSecret } from "./config/auth.config";
import { gisQueue, redisConnection } from "./services/queue.service";

const PORT = process.env.PORT || 3000;

const bootstrap = async () => {
  getAccessTokenSecret();
  await initializeDatabase();
  await connectAuthRedis();
  const { gisWorker } = await import("./workers/gis.worker");

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📚 Swagger UI: http://localhost:${PORT}/api/docs`);
    initCleanupCron();
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received; shutting down gracefully`);
    server.close(async () => {
      await Promise.allSettled([
        gisWorker.close(),
        gisQueue.close(),
        redisConnection.quit(),
        authRedis.quit(),
        database.$disconnect(),
      ]);
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
};

void bootstrap().catch((error) => {
  console.error("SnapGIS failed to start:", error);
  process.exit(1);
});
