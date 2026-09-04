import express from "express";
import {
  cancelHealing,
  healAnalyzedFile,
} from "../controllers/heal.controller";
import {
  downloadHealedOutput,
  getHealStatus,
  previewOriginalInput,
  previewHealedOutput,
  streamHealEvents,
  updateManualReview,
} from "../controllers/heal-status.controller";
import { requireAuthentication } from "../middlewares/auth.middleware";

const router = express.Router();

router.use(requireAuthentication);

router.post("/:jobId", healAnalyzedFile);
router.post("/:jobId/cancel", cancelHealing);
router.get("/:jobId/events", streamHealEvents);
router.get("/:jobId", getHealStatus);
router.get("/:jobId/original", previewOriginalInput);
router.get("/:jobId/output", previewHealedOutput);
router.get("/:jobId/download", downloadHealedOutput);
router.patch("/:jobId/reviews/:issueIndex", updateManualReview);

export { router };
