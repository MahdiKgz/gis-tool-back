import express from "express";
import {
  deleteFile,
  getFile,
  listFiles,
  renameFile,
} from "../controllers/file.controller";
import { requireAuthentication } from "../middlewares/auth.middleware";

const router = express.Router();

router.use(requireAuthentication);
router.get("/", listFiles);
router.get("/:fileId", getFile);
router.patch("/:fileId", renameFile);
router.delete("/:fileId", deleteFile);

export { router };
