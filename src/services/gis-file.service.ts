import fs from "node:fs/promises";
import path from "node:path";
import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";
import type shapefileParser from "shpjs";

type FeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
  [key: string]: unknown;
};

type ShapefileModule = {
  default: typeof shapefileParser;
  parseZip: typeof shapefileParser.parseZip;
  parseShp: typeof shapefileParser.parseShp;
};

// TypeScript emits import() as require() for this CommonJS project, while
// shpjs deliberately exposes a browser bundle to require(). Keeping the
// native dynamic import selects shpjs' Node-compatible ESM entry point.
const importShapefileModule = new Function(
  "return import('shpjs')",
) as () => Promise<ShapefileModule>;

const combineFeatureCollections = (
  collections: FeatureCollection[],
): FeatureCollection => ({
  type: "FeatureCollection",
  features: collections.flatMap((collection) => collection.features),
});

const normalizeShapefileResult = (
  result: FeatureCollection | FeatureCollection[],
): FeatureCollection =>
  Array.isArray(result) ? combineFeatureCollections(result) : result;

const parseKml = (source: string): FeatureCollection =>
  kml(new DOMParser().parseFromString(source, "text/xml")) as FeatureCollection;

export const readGisFile = async (
  filePath: string,
  originalName: string,
): Promise<unknown> => {
  const extension = path.extname(originalName).toLowerCase();

  if (extension === ".kml") {
    return parseKml(await fs.readFile(filePath, "utf8"));
  }

  if (extension === ".kmz") {
    const archive = new AdmZip(filePath);
    const kmlEntry = archive
      .getEntries()
      .find((entry) => entry.entryName.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) {
      throw new SyntaxError("KML not found inside KMZ archive");
    }
    return parseKml(kmlEntry.getData().toString("utf8"));
  }

  if (extension === ".zip") {
    const shpjs = await importShapefileModule();
    const result = await shpjs.parseZip(await fs.readFile(filePath));
    return normalizeShapefileResult(result as FeatureCollection | FeatureCollection[]);
  }

  if (extension === ".shp") {
    const shpjs = await importShapefileModule();
    const geometries = shpjs.parseShp(await fs.readFile(filePath));
    return {
      type: "FeatureCollection",
      features: geometries.map((geometry) => ({
        type: "Feature",
        properties: {},
        geometry,
      })),
    };
  }

  if (extension === ".geojson" || extension === ".json") {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  }

  throw new TypeError(`Unsupported GIS file extension: ${extension || "(none)"}`);
};
