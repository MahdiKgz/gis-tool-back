import cron from "node-cron";
import fs from "fs";
import path from "path";

const TARGET_DIRS = [
  path.join(__dirname, "../../uploads/gis_files"),
  path.join(__dirname, "../../uploads/cleaned_files"),
  path.join(__dirname, "../../uploads/gis_analyses"),
];

const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

export const initCleanupCron = (): void => {
  cron.schedule("0 1 * * *", () => {
    console.log("🧹 [Cron] Starting daily storage cleanup...");
    const now = Date.now();

    for (const dir of TARGET_DIRS) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);

      for (const file of files) {
        const filePath = path.join(dir, file);

        try {
          const stats = fs.statSync(filePath);
          const fileAge = now - stats.mtime.getTime();

          if (fileAge > ONE_WEEK_IN_MS) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ [Cron] Deleted old file: ${file}`);
          }
        } catch (error) {
          console.error(`❌ [Cron] Error processing file ${file}:`, error);
        }
      }
    }
    console.log("✅ [Cron] Cleanup task finished.");
  });
};
