import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { processDuplicateVertices } from "../processing/duplicate-vertices";
import { analyzeGisFile } from "./dry-run.service";
import { readGisFile } from "./gis-file.service";

type PolygonCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: "Polygon"; coordinates: number[][][] };
  }>;
};
const fixture = (name: string) => path.resolve("src/test-data/shapefile", name);

for (const name of ["duplicate-wgs84.shp", "projected-parcel.zip"]) {
  test(`${name} produces server GeoJSON accepted by dry-run and the healing repair stage`, async () => {
    const input = await readGisFile(fixture(name), name) as PolygonCollection;
    assert.equal(input.type, "FeatureCollection");
    assert.equal(input.features.length, 1);
    assert.equal(input.features[0]?.geometry.type, "Polygon");
    const before = structuredClone(input);
    const dryRun = await analyzeGisFile(fixture(name), name, { toleranceMillimeters: 25 });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.summary.featuresScanned, 1);
    assert.ok(dryRun.issues.some((issue) => issue.check === "duplicateVertices"));
    assert.equal(dryRun.affectedFeatureCollection.features.length, 1);
    assert.deepEqual(input, before);

    const repaired = processDuplicateVertices(input);
    assert.equal(repaired.report.duplicatesRemoved, 1);
    assert.equal(repaired.report.unresolvedDuplicates, 0);
    assert.equal(repaired.geojson.features[0]?.geometry.coordinates[0]?.length, 5);
    assert.deepEqual(input, before);
  });
}

test("zipped Shapefile preserves DBF attributes and reprojects using PRJ", async () => {
  const input = await readGisFile(fixture("projected-parcel.zip"), "projected-parcel.zip") as PolygonCollection;
  assert.equal(input.features[0]?.properties.name, "utm-parcel");
  const first = input.features[0]?.geometry.coordinates[0]?.[0];
  assert.ok(first);
  assert.ok(Math.abs(first[0]! - 51) < 1e-8);
  assert.ok(Math.abs(first[1]!) < 1e-8);
});
