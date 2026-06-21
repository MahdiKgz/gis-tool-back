import express from "express";
import { uploadGeoJson } from "../controllers/upload.controller";
import { createUploader } from "../services/upload.service";

const router = express.Router();

const geojsonUploadMiddleware = createUploader({
  destination: "./uploads/gis_files",
  allowedExtensions: [".geojson", ".json", ".kml", ".kmz", ".shp", ".zip"],
  maxSizeInMB: 5,
});

router.route("/").post(geojsonUploadMiddleware.single("file"), uploadGeoJson);

export { router };
