# DWG and DGN intake

## Runtime setup

Run from the backend project directory on Linux with Python 3.12+, pip, a C
compiler, make, curl, tar and sha256sum:

```sh
pnpm cad:setup
pnpm test:cad
```

The installer keeps Python libraries and native tools under `.cad-runtime/`,
which is excluded from Git. It pins Python dependencies, downloads the official
LibreDWG 0.13.3 release, verifies the archive SHA-256 and builds locally.
No privileged system installation is required. Restart the API if its environment
variables have changed. Deploy `scripts/` and `.cad-runtime/` alongside the compiled
backend, and run the service with the backend root as its working directory.

Optional server configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CAD_PYTHON` | `python3` | Python executable, including a custom GDAL environment |
| `CAD_PYTHONPATH` | `<backend>/.cad-runtime/python` | Python module path; set to an empty string when a custom Python environment already includes dependencies |
| `CAD_DWGREAD` | `<backend>/.cad-runtime/bin/dwgread` | LibreDWG executable |

The runtime uses pyogrio/GDAL, Shapely and PROJ. Review the distribution terms of
bundled native dependencies when distributing a deployment image; LibreDWG is
GPL software. [LibreDWG project](https://www.gnu.org/software/libredwg/)

## Supported conversion paths

- DWG: use GDAL's ODA `DWG` driver if installed, otherwise LibreDWG → temporary DXF
  → GDAL. The binary regression fixture is an R2000 DWG containing a closed parcel
  with a duplicate vertex. This does not establish support for every CAD entity
  or DWG version.
- DGN: GDAL's standard reader handles DGN v7. A binary projected polygon fixture
  is included and tested through the full healing processor.
- DGN v8: requires a custom GDAL/pyogrio runtime built with ODA support. Standard
  Python wheels do not include that driver. This environment does not have ODA;
  v8 is rejected with `DGN_V8_UNAVAILABLE` before analysis. A valid DGN-v8 conversion
  still needs to be tested on the ODA-enabled deployment.
  [GDAL DGN](https://gdal.org/en/stable/drivers/vector/dgn.html),
  [GDAL DGNv8](https://gdal.org/en/stable/drivers/vector/dgnv8.html)

Closed CAD polylines are exposed as polygons for gap/sliver checks, and open
lines remain lines. Curves are approximated using a 0.1-degree angular step;
this does not guarantee a fixed millimeter approximation error for every radius.
Layer/entity identity and attributes are retained in the normalized GeoJSON.
Native reader warnings fail the upload rather than publishing a known partial
result. The converter does not run make-valid or topology healing before dry-run.

## API and storage

`POST /api/upload` accepts the raw DWG/DGN file, `name`, `tolerance` and required
`sourceCrs` in `EPSG:<code>` form. For example `EPSG:32639` is WGS84 / UTM 39N.
The frontend asks for the source CRS instead of assuming one. Local engineering
coordinates need georeferencing before upload; an arbitrary EPSG code cannot
supply that transform.

The server transforms to WGS84 and atomically stores
`<uploaded-path>.normalized.geojson` next to the retained CAD upload. The dry-run,
healing worker and original-preview endpoint all read this same artifact.
Healing never invokes a potentially different second conversion. Removing the
normalized file requires re-upload; it is not silently regenerated. Deleting a
file removes its source and normalized artifact, while the existing seven-day
cleanup also covers both. Failed uploads remove both artifacts immediately.

The browser never reads or converts CAD bytes. It renders server-returned GeoJSON.
Healing output remains GeoJSON; exporting repaired DWG or DGN is not implemented.

## Limits and errors

Upload limit remains 5 MiB. CAD conversion accepts at most 50,000 features,
1,000,000 vertices and 256 layers, with 50 MiB output. At most two conversions run
per API process. Python/native child processes have a 60-second CPU limit,
2 GiB address-space limit and 50 MiB file-write limit on Linux; the Node parent
kills the process group after 90 seconds. Native DWG conversion also has a
45-second timeout. Conversion does not require network access.

Structured errors include `INVALID_SOURCE_CRS`, `CAD_RUNTIME_UNAVAILABLE`,
`DGN_V8_UNAVAILABLE`, `INVALID_CAD_FILE`, `CAD_INVALID_COORDINATES`,
`CAD_NO_GEOMETRY`, `CAD_OUTPUT_TOO_LARGE`, `CAD_CONVERSION_TIMEOUT`,
`CAD_CONVERSION_WARNING`, `CAD_CONVERTER_BUSY`, and `CAD_SOURCE_EXPIRED`.
The upload form shows corresponding Persian guidance.

Dry-run remains in the upload request. Larger uploads need queued conversion and
analysis plus bounded map delivery; the limit has not been increased here.

## Verification

`pnpm test` covers cache reuse, validation and cleanup without requiring native
converters. `pnpm test:cad` requires the installed runtime and runs binary DWG and
DGN through the actual upload controller, dry-run, cached preview and complete
healing processor. Queue transport is replaced in that test, so it submits no
jobs to the user's Redis instance. It also covers malformed input, unavailable
Python and the DGN-v8 capability error. It is not an ODA/DGN-v8 conversion test.
