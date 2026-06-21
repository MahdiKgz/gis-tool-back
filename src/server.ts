import app from "./app";
import dotenv from "dotenv";
import { initCleanupCron } from "./services/cleanup.service";

dotenv.config();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);

  initCleanupCron();
});
