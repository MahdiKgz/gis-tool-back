import { createStorageUpload, completeStorageUpload } from "../controllers/storage-upload.controller";
import express from "express";
import { uploadGeoJson } from "../controllers/upload.controller";
import { createUploader } from "../services/upload.service";
import { requireAuthentication } from "../middlewares/auth.middleware";

const router = express.Router();

const geojsonUploadMiddleware = createUploader({
  destination: "./uploads/gis_files",
  allowedExtensions: [".geojson", ".json", ".kml", ".kmz", ".shp", ".zip", ".dwg", ".dgn"],
  maxSizeInMB: 250,
});

router.post("/presign", requireAuthentication, createStorageUpload);
router.post("/:uploadId/complete", requireAuthentication, completeStorageUpload);

router
  .route("/")
  .post(requireAuthentication, geojsonUploadMiddleware.single("file"), uploadGeoJson);

export { router };
