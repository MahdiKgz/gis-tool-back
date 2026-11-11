import assert from "node:assert/strict";
import test from "node:test";
import { tiffPreviewOptions } from "./spatial-image-processor.service";
import { MAX_SPATIAL_IMAGE_BYTES, parseSpatialImageUpload } from "./spatial-image.service";

test("accepts TIFF uploads through 5 GiB without a 32-bit size limit", () => {
  const file = { fileName: "orthophoto.TIFF", size: MAX_SPATIAL_IMAGE_BYTES };
  assert.deepEqual(parseSpatialImageUpload(file), file);
  assert.throws(() => parseSpatialImageUpload({ ...file, size: file.size + 1 }), { code: "IMAGE_TOO_LARGE" });
  assert.throws(() => parseSpatialImageUpload({ ...file, size: 0 }), { code: "IMAGE_TOO_LARGE" });
  assert.throws(() => parseSpatialImageUpload({ ...file, fileName: "../orthophoto.tif" }), { code: "INVALID_IMAGE_NAME" });
  assert.throws(() => parseSpatialImageUpload({ ...file, fileName: "orthophoto.png" }), { code: "INVALID_IMAGE_NAME" });
});

test("requires a georeferenced TIFF and caps the map derivative at 16384 pixels per edge", () => {
  const info: Parameters<typeof tiffPreviewOptions>[0] = {
    driverShortName: "GTiff",
    coordinateSystem: { wkt: "EPSG:4326" },
    geoTransform: [51, 0.001, 0, 35, 0, -0.001],
    size: [32768, 8192],
    bands: [{ band: 1, type: "UInt16", colorInterpretation: "Gray" }],
  };
  assert.deepEqual(tiffPreviewOptions(info), [
    "-outsize", "16384", "4096", "-r", "average", "-b", "1", "-ot", "Byte", "-scale",
  ]);
  assert.throws(() => tiffPreviewOptions({ ...info, coordinateSystem: {} }), /georeferencing/);
  assert.throws(() => tiffPreviewOptions({ ...info, driverShortName: "PNG" }), /georeferencing/);
});
