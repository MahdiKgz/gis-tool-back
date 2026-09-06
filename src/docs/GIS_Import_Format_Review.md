# GIS input format review

> Historical investigation. Implementation now exists; see [CAD runtime](CAD_Runtime.md) for current support and limits.

Reviewed 2026-09-06 for the user-requested Shapefile, DWG and DGN intake.

## Current implementation

| Input | Backend | Frontend intake after this change |
| --- | --- | --- |
| GeoJSON / JSON | Parsed by `readGisFile` | Accepted; sent unchanged |
| KML / KMZ | Converted to GeoJSON by `readGisFile` | Accepted; sent unchanged |
| Shapefile `.shp` | Existing `shpjs.parseShp` geometry reader | Accepted; source coordinates must already be WGS84 |
| Shapefile `.zip` | Existing `shpjs.parseZip`; combines collections | Accepted; recommended for projection and attributes |
| DWG | No converter or accepted upload extension | Not advertised as supported |
| DGN | No converter or accepted upload extension | Not advertised as supported |

No `ogr2ogr` executable was found on PATH in the inspected development environment.
The backend package manifest has `shpjs` but no CAD converter. Deployment image
capabilities still need to be checked separately before enabling CAD intake.

### Existing engine integration

All three server consumers already share `src/services/gis-file.service.ts`:

1. Upload calls `analyzeGisFile`, which calls `readGisFile` and then `analyzeGeoJson`.
2. `gis.worker.ts` calls `readGisFile` before geometry validation and healing processors.
3. `previewOriginalInput` uses it to return the retained source as GeoJSON.

A new converter should feed this shared boundary. The topology algorithms should
not receive raw CAD or Shapefile bytes. Healing currently produces GeoJSON;
export back to the original CAD format is a separate feature.

### Browser behavior

The frontend no longer reads uploaded files with `text`, `arrayBuffer`, XML parsing
or ZIP decompression. Its local `parseGeoFile` and `previewFile` paths and their
parser dependencies have been removed. It sends the selected `File` in FormData.
Only a successful server response publishes dry-run results. The map renders
`report.affectedFeatureCollection`; healed and original previews also come from
server endpoints. An empty affected collection displays no affected geometry.

This removes the duplicate local conversion cost. Rendering very large GeoJSON
responses can still cost browser CPU and memory. Large-dataset delivery should
use viewport-based features or vector tiles; simply moving file parsing to the
server does not bound rendering costs. The existing upload limit remains 5 MB.

## Shapefile findings

Use ZIP containing matching `.shp`, `.shx`, `.dbf` and `.prj` files. `shpjs` uses
DBF for attributes and PRJ for reprojection to WGS84; CPG can describe attribute
encoding. A bare SHP lacks these sidecars and our reader returns geometry with
empty properties. Missing CRS is not reliably detectable from coordinate ranges.
Do not treat unlabelled projected coordinates as longitude/latitude.
[shpjs documentation](https://github.com/calvinmetcalf/shapefile-js)

Added synthetic fixtures and regression tests cover bare WGS84 SHP, a ZIP in
EPSG:32639, DBF attributes, PRJ reprojection, dry-run duplicate findings and the
duplicate-vertex repair processor used by the healing worker. These tests do not
exercise a full queued job or every Shapefile geometry/encoding variant.

## CAD conversion requirements

### Driver choice

GDAL's `DWG` driver uses the ODA library and reads most DWG versions. The alternate
`CAD` driver uses libopencad with a different, version-dependent support matrix;
it must not be assumed equivalent. Pick the driver against representative input
files and record its supported versions.
[DWG driver](https://gdal.org/en/stable/drivers/vector/dwg.html),
[CAD driver](https://gdal.org/en/stable/drivers/vector/cad.html)

The standard `DGN` driver handles pre-v8 DGN. DGN v8 requires the separate
`DGNv8` driver and ODA build dependency. A generic GDAL install alone therefore
does not establish support for both requested CAD formats.
[DGN driver](https://gdal.org/en/stable/drivers/vector/dgn.html),
[DGNv8 driver](https://gdal.org/en/stable/drivers/vector/dgnv8.html)

### Coordinates and topology

The DWG driver does not supply georeferencing. Intake must request the source
CRS when missing and transform to WGS84 before the current engine. Local CAD
coordinates require an actual georeferencing transform; choosing an arbitrary
EPSG code is insufficient. The chosen CRS and conversion options must persist
with the analysis so dry-run and healing use identical geometry.
[DWG georeferencing behavior](https://gdal.org/en/stable/drivers/vector/dwg.html)

Closed CAD polylines may arrive as lines, so gap and sliver checks would not see
polygons. Define which closed entities represent areas, preserve CAD layer and
entity identifiers, and keep open lines as lines. GDAL >= 3.10 exposes
`DWG_CLOSED_LINE_AS_POLYGON`; it defaults to false. Curves are approximated, so the
approximation error must be recorded and suitable for the engine's millimeter
thresholds. Do not silently polygonize arbitrary linework or repair geometry
before the dry run has reported it.
[DWG conversion options](https://gdal.org/en/stable/drivers/vector/dwg.html)

### Proposed implementation sequence

1. Validate representative DWG and DGN versions against the deployed GDAL/ODA
   build; document distribution requirements for that chosen runtime.
2. Add a converter behind `readGisFile`, with a separate process, time and output
   limits, an isolated temporary directory, explicit arguments (no shell string),
   and structured errors for unsupported versions, missing CRS and failed conversion.
3. Persist a normalized WGS84 GeoJSON artifact, source metadata and conversion
   warnings. Feed that same artifact to dry-run, healing and original preview.
4. Expose server-supported formats to the frontend. Enable `.dwg` and `.dgn` only
   when their converters are available; show a source-CRS field when required.
5. Add binary fixtures for supported DWG and DGN versions, closed boundaries with
   a known gap/sliver, arcs, blocks, attributes, projected coordinates, unsupported
   entities and conversion failures. Test upload → dry-run → queued healing → output.
6. For larger files, queue conversion and dry-run too. Currently dry-run runs in
   the upload request; increasing the limit alone would move the bottleneck to
   the API process. Bound server processing and map response sizes together.

DWG/DGN conversion is a researched follow-up, not implemented by this change.
