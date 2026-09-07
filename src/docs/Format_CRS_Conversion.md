# Standalone format and CRS conversion

## Scope and entry point

The authenticated `/dashboard/convert` utility supports GeoJSON, a ZIP containing
one Shapefile dataset, and DXF, in both directions. It converts format and/or CRS
without invoking dry-run, healing, manual review, database file records or SSE.
KML conversion is deferred per the supplied plan; existing topology KML ingestion
is unchanged. DWG/DGN conversion belongs to the topology intake route, not this
standalone utility's initial format set.

The implementation reuses the installed `.cad-runtime` (GDAL/pyogrio, Shapely and
PROJ). `scripts/crs_utils.py` supplies the shared CRS/transformer primitives used by
both CAD intake and conversion; there was no existing JavaScript proj4 utility to
extract. Run `pnpm cad:setup` if this runtime is not installed. No new native
packages are needed. `CAD_PYTHON` and `CAD_PYTHONPATH` overrides continue to apply.

## API

All endpoints require the existing Bearer access token. Every queued status and
download lookup checks the authenticated owner and returns 404 for other owners.

`POST /api/convert` is `multipart/form-data` with exactly one `file` and at most
these three scalar options:

- `targetFormat`: `geojson`, `shapefile`, or `dxf`; omitted preserves input format.
- `sourceCRS`: EPSG identifier, such as `EPSG:32639`; required for DXF and for
  Shapefile without PRJ. An explicit source overrides embedded CRS intentionally.
- `targetCRS`: EPSG identifier; omitted preserves the resolved source CRS.

GeoJSON defaults to EPSG:4326 unless it contains named CRS metadata. Shapefile CRS
is detected from its PRJ. XY always means longitude/easting, latitude/northing;
PROJ uses `always_xy=True`, rejects ballpark transforms and does not download grids.
Unavailable transformations and nonfinite/out-of-range geographic coordinates fail
explicitly. Conversion does not close invalid GeoJSON polygon rings or repair
invalid topology.

- Up to **5 MiB**: 200 with a binary attachment, `Content-Disposition`, and
  `X-Conversion-Result` containing a URI-encoded JSON report with `features`,
  `sourceCRS`, `targetCRS`, and `warnings`. These headers are exposed to the browser.
- Above 5 MiB, up to **250 MiB**: 202 with
  `{ "success": true, "data": { "jobId": "uuid", "status": "queued" } }`.
- `GET /api/convert/:id`: owner-scoped status: `processing`, `completed` (with
  result metadata), or `failed` (with a public error code).
- `GET /api/convert/:id/download`: binary attachment when ready; 409 if not ready,
  410 if output expired. The front end polls the status with a plain waiting
  message; it does not connect to healing SSE or staged progress.

The plan's suggested 100–250 MB synchronous threshold did not exist in the code:
topology uploads are currently capped at 5 MiB. Conversion conservatively retains
that synchronous threshold while allowing larger inputs through BullMQ. The
existing Redis connection and worker lifecycle are reused with a separate
`gis-conversion-queue`; topology workers never receive conversion tasks. Queue
unavailability fails clearly without affecting small synchronous conversions.

## Format fidelity

- Shapefile export returns SHP, SHX, DBF, PRJ and CPG together in one ZIP. A single
  geometry family is required. Long/colliding field names are mapped to DBF-safe
  names; `conversion-metadata.json` records the original names. Nested attributes
  become JSON strings; DBF numeric representation differs from JSON and is
  disclosed. Text exceeding 254 UTF-8 bytes, unreliable numeric values, driver
  truncation warnings, mixed geometry families, and empty geometries fail rather
  than silently returning partial data. Reimport uses the actual DBF field names,
  not the supplementary name mapping.
- DXF export writes basic POINT, LWPOLYLINE (2D), and POLYLINE/VERTEX (3D) entities.
  Polygon outer/hole boundaries become independent closed polylines. Attribute
  tables, polygon/hole associations and CAD styling are not retained, and these
  limitations are shown before conversion and in the result notices. No blocks,
  annotation styling or CAD round-trip fidelity is promised.
- GeoJSON retains properties and feature IDs for GeoJSON-to-GeoJSON conversion.
  Non-WGS84 output carries a legacy named `crs` member and a warning: this is not
  RFC 7946 GeoJSON, and clients must support the chosen CRS. Use EPSG:4326 for
  broadly interoperable GeoJSON. Feature IDs are not exported as CAD/DBF IDs.
- Null/empty geometries and GeometryCollections are explicitly unsupported in v1.

## Resource limits and retention

The converter runs in a bounded child process, off the Node event loop. Limits:
250 MiB upload, 500 MiB expanded archive/output, 500,000 features, 5,000,000
vertices, 32 archive members, 3 GiB process address space, 240 CPU seconds,
300 seconds elapsed, at most two conversions per server process (one queue worker).
Shapefile ZIPs must contain exactly one matching SHP/SHX/DBF set, with optional
PRJ/CPG. Traversal, encrypted entries, duplicate flattened names, and excessive
expansion are rejected. Only the expected GDAL driver is accepted for each format.

Synchronous input/output files are deleted after download, failure or disconnect;
no input is parsed in the browser. Queued downloads expire after 24 hours; job records are retained
for approximately that period and the existing daily cleanup removes expired conversion
directories. At scale, API and worker processes must share the conversion directory,
just as existing GIS jobs require shared upload storage. Keep disk/worker limits in
mind before increasing limits or concurrency.

## Verification

- `pnpm test`: unit/controller and regression suite (native integration opt-in).
- `pnpm test:conversion`: real GDAL round trips, PRJ detection, known CRS transform,
  Persian attributes, polygon holes, DXF polylines, HTTP upload/download, queue
  dispatch contract, bad CRS, missing PRJ, unsupported attributes and geometry.
- `pnpm test:cad`: existing binary DWG/DGN regression suite for shared CRS helpers.
- `pnpm build`: production TypeScript/Prisma build.

Frontend: `pnpm exec vitest run`, `pnpm build`. The UI has tests for binary result
handling, input validation, direct/queued paths, error display, and abort/URL cleanup.
