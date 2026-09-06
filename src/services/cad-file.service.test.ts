import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCadFileReader, normalizedCadPath, parseCadSourceCrs } from "./cad-file.service";

const collection = { type: "FeatureCollection", features: [{ type: "Feature", properties: { Layer: "parcels" }, geometry: { type: "Point", coordinates: [51, 35] } }] };

test("CAD source CRS accepts explicit EPSG values and rejects arbitrary converter arguments", () => {
  assert.equal(parseCadSourceCrs(" epsg:32639 "), "EPSG:32639");
  for (const value of [undefined, null, [], "", "32639", "EPSG:0", "EPSG:4326 -f DXF", "../../file", "EPSG:9999999"]) {
    assert.throws(() => parseCadSourceCrs(value), { code: "INVALID_SOURCE_CRS" });
  }
});

test("CAD normalization is reused unchanged by subsequent preview and healing reads", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "drawing.dwg");
  await fs.writeFile(source, "binary placeholder");
  let conversions = 0;
  const read = createCadFileReader(async (input, output, crs) => {
    conversions++;
    assert.equal(input, source);
    assert.equal(crs, "EPSG:32639");
    await fs.writeFile(output, JSON.stringify(collection));
  });
  assert.deepEqual(await read(source, "EPSG:32639"), collection);
  assert.deepEqual(await read(source), collection);
  assert.deepEqual(await read(source), collection);
  assert.equal(conversions, 1);
  assert.deepEqual(await fs.readdir(dir), ["drawing.dwg", "drawing.dwg.normalized.geojson"]);
  await fs.rm(normalizedCadPath(source));
  await assert.rejects(read(source), { code: "CAD_SOURCE_EXPIRED" });
  assert.equal(conversions, 1);
});

test("failed CAD conversion removes partial output and never publishes an artifact", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-failure-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const read = createCadFileReader(async (_source, output) => {
    await fs.writeFile(output, "partial");
    throw new Error("conversion failed");
  });
  await assert.rejects(read(path.join(dir, "drawing.dgn"), "EPSG:4326"), /conversion failed/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("an empty CAD conversion cannot be recorded as a successful upload", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-empty-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const read = createCadFileReader(async (_source, output) => {
    await fs.writeFile(output, JSON.stringify({ type: "FeatureCollection", features: [] }));
  });
  await assert.rejects(read(path.join(dir, "drawing.dgn"), "EPSG:4326"), { code: "CAD_NO_GEOMETRY" });
  assert.deepEqual(await fs.readdir(dir), []);
});
