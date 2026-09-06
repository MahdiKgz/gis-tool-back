"""Isolated CAD -> WGS84 GeoJSON converter. Invoked by cad-file.service.ts."""
import json
import math
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import warnings


def fail(code, message):
    print(json.dumps({"code": code, "message": message}), file=sys.stderr)
    raise SystemExit(1)


try:
    import pyogrio
    from pyogrio.raw import read
    from pyproj import CRS, Transformer
    from shapely import from_wkb
    from shapely.geometry import mapping
    from shapely.ops import transform
except ImportError:
    fail("CAD_RUNTIME_UNAVAILABLE", "CAD conversion dependencies are not installed on the server.")

MAX_FEATURES = 50000
MAX_VERTICES = 1000000
MAX_OUTPUT_BYTES = 50 * 1024 * 1024


def scalar(value):
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (tuple, list)):
        return [scalar(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def vertex_count(geometry):
    if geometry["type"] == "GeometryCollection":
        return sum(vertex_count(item) for item in geometry["geometries"])

    def visit(values):
        if not values:
            return 0
        if isinstance(values[0], (int, float)):
            if not all(math.isfinite(value) for value in values):
                fail("CAD_INVALID_COORDINATES", "CAD coordinates could not be transformed to WGS84.")
            if not (-180 <= values[0] <= 180 and -90 <= values[1] <= 90):
                fail("CAD_INVALID_COORDINATES", "CAD coordinates are outside WGS84 bounds. Check the source CRS.")
            return 1
        return sum(visit(item) for item in values)

    return visit(geometry["coordinates"])


def convert(source, target, source_crs, dwgread):
    try:
        crs = CRS.from_user_input(source_crs)
        if not (crs.is_geographic or crs.is_projected):
            fail("INVALID_SOURCE_CRS", "Choose a geographic or projected EPSG coordinate system.")
        transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True, allow_ballpark=False)
    except Exception:
        fail("INVALID_SOURCE_CRS", "The supplied EPSG coordinate system cannot be transformed to WGS84.")

    drivers = pyogrio.list_drivers()
    suffix = source.suffix.lower()
    with tempfile.TemporaryDirectory(prefix="snapgis-cad-") as scratch:
        dataset = source
        allowed_drivers = {"DGN", "DGNv8"} if suffix == ".dgn" else {"DWG", "CAD"}
        if suffix == ".dgn":
            with source.open("rb") as handle:
                is_v8 = handle.read(8) == bytes.fromhex("d0cf11e0a1b11ae1")
            if is_v8 and "DGNv8" not in drivers:
                fail("DGN_V8_UNAVAILABLE", "DGN v8 requires an ODA-enabled GDAL runtime on the server.")
        elif suffix == ".dwg" and "DWG" not in drivers:
            dataset = Path(scratch) / "drawing.dxf"
            try:
                completed = subprocess.run(
                    [dwgread, "-O", "DXF", "-o", str(dataset), str(source)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=45, check=False,
                )
            except FileNotFoundError:
                fail("CAD_RUNTIME_UNAVAILABLE", "The server DWG converter is not installed.")
            except subprocess.TimeoutExpired:
                fail("CAD_CONVERSION_TIMEOUT", "DWG conversion exceeded the time limit.")
            if completed.returncode != 0 or not dataset.exists():
                fail("INVALID_CAD_FILE", "The DWG file is invalid or uses unsupported entities or a version this converter cannot read.")
            if re.search(rb"(?:^|\n)(?:ERROR|Warning|WARN)\b", completed.stderr, re.IGNORECASE):
                fail("CAD_CONVERSION_WARNING", "The DWG reader reported a warning; partial geometry was not accepted.")
            if dataset.stat().st_size > MAX_OUTPUT_BYTES:
                fail("CAD_OUTPUT_TOO_LARGE", "The converted drawing exceeds the server size limit.")
            allowed_drivers = {"DXF"}
        elif suffix != ".dwg":
            if suffix != ".dgn":
                fail("INVALID_CAD_FILE", "Only DWG and DGN inputs are accepted by this converter.")

        pyogrio.set_gdal_config_options({
            "DWG_CLOSED_LINE_AS_POLYGON": "TRUE",
            "DXF_CLOSED_LINE_AS_POLYGON": "TRUE",
            "OGR_ARC_STEPSIZE": "0.1",
            "PROJ_NETWORK": "OFF",
        })
        layers = pyogrio.list_layers(dataset)
        if len(layers) > 256:
            fail("CAD_OUTPUT_TOO_LARGE", "The drawing contains too many layers.")
        features = []
        vertices = 0
        for layer_name, geometry_type in layers:
            if geometry_type is None:
                continue
            info = pyogrio.read_info(dataset, layer=layer_name)
            if info["driver"] not in allowed_drivers:
                fail("INVALID_CAD_FILE", "The file content does not match its CAD extension.")
            # Read in bounded batches, preserving layer order and source FIDs.
            offset = 0
            while True:
                meta, fids, geometries, fields = read(
                    dataset, layer=layer_name, skip_features=offset,
                    max_features=5000, return_fids=True,
                )
                if geometries is None or not len(geometries):
                    break
                for index, wkb in enumerate(geometries):
                    if wkb is None:
                        fail("INVALID_CAD_FILE", "The drawing contains an entity without convertible geometry.")
                    geometry = mapping(transform(transformer.transform, from_wkb(wkb)))
                    vertices += vertex_count(geometry)
                    if vertices > MAX_VERTICES or len(features) >= MAX_FEATURES:
                        fail("CAD_OUTPUT_TOO_LARGE", "The drawing exceeds the server geometry limit.")
                    features.append({
                        "type": "Feature", "id": f"{layer_name}:{fids[index]}",
                        "properties": {str(name): scalar(fields[column][index]) for column, name in enumerate(meta["fields"])},
                        "geometry": geometry,
                        "snapgisCad": {"layer": str(layer_name), "entityId": str(fids[index])},
                    })
                offset += len(geometries)
                if len(geometries) < 5000:
                    break
        if not features:
            fail("CAD_NO_GEOMETRY", "The drawing contains no convertible spatial entities.")
        data = {"type": "FeatureCollection", "features": features}
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_OUTPUT_BYTES:
            fail("CAD_OUTPUT_TOO_LARGE", "The converted drawing exceeds the server size limit.")
        target.write_text(encoded, encoding="utf-8")
        print(json.dumps({"features": len(features), "sourceCrs": source_crs, "targetCrs": "EPSG:4326"}))


if __name__ == "__main__":
    # Resource limits also apply to the native DWG child process on Linux.
    if sys.platform == "linux":
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    try:
        with warnings.catch_warnings(record=True) as recorded:
            warnings.simplefilter("always")
            convert(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4])
            # Do not silently accept a partially decoded drawing.
            if recorded:
                Path(sys.argv[2]).unlink(missing_ok=True)
                fail("CAD_CONVERSION_WARNING", "The CAD reader reported a conversion warning; the drawing was not accepted.")
    except SystemExit:
        raise
    except Exception:
        fail("INVALID_CAD_FILE", "The drawing could not be converted. Check its version and source coordinate system.")
