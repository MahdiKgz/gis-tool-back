import express from "express";
import { healAnalyzedFile } from "../controllers/heal.controller";
import {
  downloadHealedOutput,
  getHealStatus,
  previewHealedOutput,
} from "../controllers/heal-status.controller";
import { requireAuthentication } from "../middlewares/auth.middleware";

const router = express.Router();

router.use(requireAuthentication);

router.post("/:jobId", healAnalyzedFile);
router.get("/:jobId", getHealStatus);
router.get("/:jobId/output", previewHealedOutput);
router.get("/:jobId/download", downloadHealedOutput);

export { router };
