import express from "express";
import { healAnalyzedFile } from "../controllers/heal.controller";

const router = express.Router();

router.post("/:jobId", healAnalyzedFile);

export { router };
