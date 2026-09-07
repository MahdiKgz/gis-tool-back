import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import {
  ConversionTask,
  conversionOutput,
  createConversionDirectory,
  removeConversion,
  runConversion,
} from "./conversion.service";

const integration =
  process.env.CONVERSION_INTEGRATION === "1" ? test : test.skip;
const polygon = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "قطعه آزمایشی", height: 12 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [51, 35],
            [51.01, 35],
            [51.01, 35.01],
            [51, 35.01],
            [51, 35],
          ],
        ],
      },
    },
  ],
};
async function fixture(
  targetFormat: ConversionTask["targetFormat"],
  data: unknown = polygon,
) {
  const { id, directory } = await createConversionDirectory();
  const source = path.join(directory, "input.geojson");
  await fs.writeFile(source, JSON.stringify(data));
  return {
    id,
    directory,
    source,
    userId: "test-owner",
    inputFormat: "geojson" as const,
    targetFormat,
  };
}
function closeTo(actual: number, expected: number, tolerance = 1e-7) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );
}

integration(
  "real GeoJSON → Shapefile ZIP → GeoJSON preserves geometry, Persian attributes, holes and auto-detected PRJ",
  async () => {
    const data = structuredClone(polygon);
    data.features[0]!.geometry.coordinates.push([
      [51.002, 35.002],
      [51.004, 35.002],
      [51.004, 35.004],
      [51.002, 35.004],
      [51.002, 35.002],
    ]);
    const task = await fixture("shapefile", data);
    const reverse = await fixture("geojson");
    try {
      const result = await runConversion({ ...task, targetCRS: "EPSG:32639" });
      assert.equal(result.features, 1);
      const zip = new AdmZip(conversionOutput(task));
      for (const extension of ["shp", "shx", "dbf", "prj", "cpg"])
        assert.ok(zip.getEntry(`converted.${extension}`));
      const source = path.join(reverse.directory, "input.zip");
      await fs.copyFile(conversionOutput(task), source);
      const back = await runConversion({
        ...reverse,
        source,
        inputFormat: "shapefile",
        targetCRS: "EPSG:4326",
      });
      assert.equal(back.sourceCRS, "EPSG:32639");
      const json = JSON.parse(
        await fs.readFile(conversionOutput(reverse), "utf8"),
      );
      assert.equal(json.features[0].properties.name, "قطعه آزمایشی");
      assert.equal(json.features[0].properties.height, 12);
      assert.equal(json.features[0].geometry.coordinates.length, 2);
      const coordinates = json.features[0].geometry
        .coordinates[0] as number[][];
      closeTo(Math.min(...coordinates.map((x) => x[0]!)), 51);
      closeTo(Math.max(...coordinates.map((x) => x[1]!)), 35.01);
    } finally {
      await removeConversion(task.directory);
      await removeConversion(reverse.directory);
    }
  },
);

integration(
  "real DXF writes LWPOLYLINE and can be read/reprojected back",
  async () => {
    const task = await fixture("dxf");
    const reverse = await fixture("geojson");
    try {
      const result = await runConversion({ ...task, targetCRS: "EPSG:32639" });
      assert.ok(result.warnings.includes("DXF_GEOMETRY_ONLY"));
      assert.match(
        await fs.readFile(conversionOutput(task), "utf8"),
        /LWPOLYLINE/,
      );
      const source = path.join(reverse.directory, "input.dxf");
      await fs.copyFile(conversionOutput(task), source);
      await runConversion({
        ...reverse,
        source,
        inputFormat: "dxf",
        sourceCRS: "EPSG:32639",
        targetCRS: "EPSG:4326",
      });
      const data = JSON.parse(
        await fs.readFile(conversionOutput(reverse), "utf8"),
      );
      assert.equal(data.features.length, 1);
      assert.equal(data.features[0].geometry.type, "Polygon");
      closeTo(data.features[0].geometry.coordinates[0][0][0], 51);
      closeTo(data.features[0].geometry.coordinates[0][0][1], 35);
    } finally {
      await removeConversion(task.directory);
      await removeConversion(reverse.directory);
    }
  },
);

integration(
  "standalone CRS-only conversion transforms known UTM point and preserves Z",
  async () => {
    const task = await fixture("geojson", {
      type: "Feature",
      properties: { tag: "point" },
      geometry: { type: "Point", coordinates: [51, 0, 25] },
    });
    try {
      await runConversion({ ...task, targetCRS: "EPSG:32639" });
      const data = JSON.parse(
        await fs.readFile(conversionOutput(task), "utf8"),
      );
      assert.equal(data.crs.properties.name, "EPSG:32639");
      closeTo(data.features[0].geometry.coordinates[0], 500000, 0.001);
      closeTo(data.features[0].geometry.coordinates[1], 0, 0.001);
      assert.equal(data.features[0].geometry.coordinates[2], 25);
    } finally {
      await removeConversion(task.directory);
    }
  },
);

integration(
  "missing PRJ requires sourceCRS and a malformed EPSG never yields an output",
  async () => {
    const task = await fixture("shapefile");
    const reverse = await fixture("geojson");
    try {
      await runConversion(task);
      const archive = new AdmZip(conversionOutput(task));
      archive.deleteFile("converted.prj");
      const source = path.join(reverse.directory, "input.zip");
      archive.writeZip(source);
      await assert.rejects(
        runConversion({ ...reverse, source, inputFormat: "shapefile" }),
        { code: "SOURCE_CRS_REQUIRED" },
      );
      await runConversion({
        ...reverse,
        source,
        inputFormat: "shapefile",
        sourceCRS: "EPSG:4326",
      });
      await assert.rejects(
        runConversion({ ...reverse, targetCRS: "EPSG:999999" }),
        { code: "INVALID_TARGET_CRS" },
      );
      await assert.rejects(fs.stat(conversionOutput(reverse)), {
        code: "ENOENT",
      });
    } finally {
      await removeConversion(task.directory);
      await removeConversion(reverse.directory);
    }
  },
);

integration(
  "mixed geometry and overlong DBF values fail explicitly instead of silently dropping data",
  async () => {
    const mixed = structuredClone(polygon) as {
      type: string;
      features: unknown[];
    };
    mixed.features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [51, 35] },
    });
    const task = await fixture("shapefile", mixed);
    try {
      await assert.rejects(runConversion(task), {
        code: "UNSUPPORTED_CONVERSION_GEOMETRY",
      });
      const data = structuredClone(polygon);
      data.features[0]!.properties.name = "a".repeat(255);
      await fs.writeFile(task.source, JSON.stringify(data));
      await assert.rejects(runConversion(task), {
        code: "UNSUPPORTED_CONVERSION_ATTRIBUTES",
      });
    } finally {
      await removeConversion(task.directory);
    }
  },
);

integration("archive with multiple Shapefiles is rejected", async () => {
  const task = await fixture("geojson");
  try {
    const archive = new AdmZip();
    archive.addFile("one.shp", Buffer.from("bad"));
    archive.addFile("two.shp", Buffer.from("bad"));
    const source = path.join(task.directory, "input.zip");
    archive.writeZip(source);
    await assert.rejects(
      runConversion({ ...task, source, inputFormat: "shapefile" }),
      { code: "INVALID_CONVERSION_FILE" },
    );
  } finally {
    await removeConversion(task.directory);
  }
});

integration(
  "CRS-only GeoJSON retains feature IDs and rejects unclosed rings and invalid source coordinates",
  async () => {
    const task = await fixture("geojson", {
      type: "Feature",
      id: "parcel-123",
      properties: {},
      geometry: { type: "Point", coordinates: [51, 0] },
    });
    try {
      await runConversion({ ...task, targetCRS: "EPSG:32639" });
      const data = JSON.parse(
        await fs.readFile(conversionOutput(task), "utf8"),
      );
      assert.equal(data.features[0].id, "parcel-123");
      const invalid = structuredClone(polygon);
      invalid.features[0]!.geometry.coordinates[0]!.pop();
      await fs.writeFile(task.source, JSON.stringify(invalid));
      await assert.rejects(runConversion(task), {
        code: "INVALID_CONVERSION_FILE",
      });
      await fs.writeFile(
        task.source,
        JSON.stringify({ type: "Point", coordinates: [500000, 4000000] }),
      );
      await assert.rejects(
        runConversion({ ...task, targetCRS: "EPSG:32639" }),
        { code: "INVALID_CONVERSION_COORDINATES" },
      );
    } finally {
      await removeConversion(task.directory);
    }
  },
);
