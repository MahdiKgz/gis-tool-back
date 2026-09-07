"""Bounded standalone format conversion. No topology analysis or repair is invoked."""
import json
import math
import os
from pathlib import Path
import re
import sys
import warnings
import zipfile


def fail(code, message):
    raise ConversionError(code, message)


class ConversionError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


try:
    import numpy as np
    import pyogrio
    from pyogrio.raw import read, write
    from shapely import from_wkb, to_wkb, get_coordinates
    from shapely.geometry import shape, mapping
    from shapely.ops import transform
    from crs_utils import coordinate_system, coordinate_transformer
except ImportError:
    print(json.dumps({"code": "CONVERSION_RUNTIME_UNAVAILABLE", "message": "Install the server GIS runtime (pnpm cad:setup)."}), file=sys.stderr)
    sys.exit(1)

MAX_INPUT = 250 * 1024**2
MAX_OUTPUT = 500 * 1024**2
MAX_FEATURES = 500000
MAX_VERTICES = 5000000


def scalar(value):
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (list, tuple)):
        return [scalar(x) for x in value]
    if value is None or isinstance(value, (str, int, float, bool, dict)):
        return value
    return str(value)


def unpack_shapefile(source, directory):
    with zipfile.ZipFile(source) as archive:
        entries = [item for item in archive.infolist() if not item.is_dir()]
        if len(entries) > 32 or sum(item.file_size for item in entries) > MAX_OUTPUT:
            fail("CONVERSION_LIMIT_EXCEEDED", "The expanded Shapefile archive exceeds the conversion limit.")
        seen = set()
        for item in entries:
            name = Path(item.filename)
            if name.is_absolute() or ".." in name.parts or "\\" in item.filename or item.flag_bits & 1:
                fail("INVALID_CONVERSION_FILE", "Unsafe or encrypted archive entry.")
            if name.name.lower() in seen:
                fail("INVALID_CONVERSION_FILE", "Duplicate archive file names.")
            seen.add(name.name.lower())
            if item.file_size > 1024**2 and item.file_size > max(1, item.compress_size) * 1000:
                fail("CONVERSION_LIMIT_EXCEEDED", "The archive compression ratio exceeds the limit.")
        shapes = [item for item in entries if item.filename.lower().endswith(".shp")]
        if len(shapes) != 1:
            fail("INVALID_CONVERSION_FILE", "Upload one Shapefile dataset per ZIP.")
        stem = Path(shapes[0].filename).stem.lower()
        companion = {Path(item.filename).suffix.lower(): item for item in entries
                     if Path(item.filename).stem.lower() == stem}
        if not {".shp", ".shx", ".dbf"}.issubset(companion):
            fail("INVALID_CONVERSION_FILE", "Shapefile ZIP must contain matching SHP, SHX and DBF files.")
        for extension in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
            if extension in companion:
                with archive.open(companion[extension]) as src, (directory / ("input" + extension)).open("wb") as dst:
                    import shutil
                    shutil.copyfileobj(src, dst, 1024 * 1024)
        return directory / "input.shp"


def load_input(source, input_format, source_crs, scratch):
    features = []
    ids = []
    detected = None
    if input_format == "geojson":
        with source.open(encoding="utf-8-sig") as handle:
            data = json.load(handle, parse_constant=lambda value: fail("INVALID_CONVERSION_FILE", "Non-finite JSON number."))
        if not isinstance(data, dict):
            fail("INVALID_CONVERSION_FILE", "Expected a GeoJSON object.")
        if "crs" in data:
            try:
                detected = data["crs"]["properties"]["name"]
            except (KeyError, TypeError):
                fail("INVALID_SOURCE_CRS", "Invalid GeoJSON CRS metadata.")
        detected = detected or "EPSG:4326"
        raw = data.get("features") if data.get("type") == "FeatureCollection" else [data] if data.get("type") == "Feature" else [{"type": "Feature", "properties": {}, "geometry": data}]
        if not isinstance(raw, list) or len(raw) > MAX_FEATURES:
            fail("CONVERSION_LIMIT_EXCEEDED", "Too many features or invalid feature collection.")
        for feature in raw:
            if not isinstance(feature, dict) or feature.get("type") != "Feature" or not isinstance(feature.get("geometry"), dict) or not isinstance(feature.get("properties") or {}, dict):
                fail("INVALID_CONVERSION_FILE", "Every feature must have a geometry and object properties.")
            geometry = feature["geometry"]
            kind = geometry.get("type")
            polygons = [geometry.get("coordinates", [])] if kind == "Polygon" else geometry.get("coordinates", []) if kind == "MultiPolygon" else []
            for polygon in polygons:
                for ring in polygon:
                    if len(ring) < 4 or ring[0] != ring[-1]:
                        fail("INVALID_CONVERSION_FILE", "Polygon rings must already be closed; conversion does not repair geometry.")
            features.append((shape(geometry), feature.get("properties") or {}))
            ids.append(feature.get("id"))
    else:
        dataset = unpack_shapefile(source, scratch) if input_format == "shapefile" else source
        info = pyogrio.read_info(dataset)
        expected_driver = "ESRI Shapefile" if input_format == "shapefile" else "DXF"
        if info["driver"] != expected_driver:
            fail("INVALID_CONVERSION_FILE", "The file content does not match its format.")
        if len(pyogrio.list_layers(dataset)) != 1:
            fail("INVALID_CONVERSION_FILE", "Upload a single dataset.")
        detected = info.get("crs")
        if input_format == "dxf" and not source_crs:
            fail("SOURCE_CRS_REQUIRED", "DXF requires an explicit source CRS.")
        offset = 0
        while True:
            meta, _, geometries, fields = read(dataset, skip_features=offset, max_features=5000)
            if geometries is None or not len(geometries):
                break
            if len(features) + len(geometries) > MAX_FEATURES:
                fail("CONVERSION_LIMIT_EXCEEDED", "Too many features.")
            for index, wkb in enumerate(geometries):
                if wkb is None:
                    fail("INVALID_CONVERSION_FILE", "Features without geometry are not supported.")
                props = {str(name): scalar(fields[column][index]) for column, name in enumerate(meta["fields"])}
                features.append((from_wkb(wkb), props))
            offset += len(geometries)
            if len(geometries) < 5000:
                break
    if not features:
        fail("CONVERSION_NO_GEOMETRY", "The file contains no convertible features.")
    resolved = source_crs or detected
    if not resolved:
        fail("SOURCE_CRS_REQUIRED", "Source CRS is missing. Include a PRJ file or specify sourceCRS.")
    try:
        return features, coordinate_system(resolved), ids
    except Exception:
        fail("INVALID_SOURCE_CRS", "The source CRS is not supported.")


def validate_geometry(geometry):
    if geometry.is_empty or geometry.geom_type == "GeometryCollection":
        fail("UNSUPPORTED_CONVERSION_GEOMETRY", "Empty geometries and GeometryCollections are not supported.")
    coords = get_coordinates(geometry, include_z=geometry.has_z)
    if not np.isfinite(coords).all():
        fail("INVALID_CONVERSION_COORDINATES", "Coordinates must be finite.")
    return len(coords)


def write_geojson(output, features, crs, ids):
    with output.open("w", encoding="utf-8") as handle:
        handle.write('{"type":"FeatureCollection",')
        if not crs.equals(coordinate_system("EPSG:4326")):
            handle.write('"crs":' + json.dumps({"type": "name", "properties": {"name": crs.to_string()}}) + ',')
        handle.write('"features":[')
        for index, (geometry, props) in enumerate(features):
            if index:
                handle.write(',')
            feature = {"type": "Feature", "properties": props, "geometry": mapping(geometry)}
            if index < len(ids) and ids[index] is not None:
                feature["id"] = ids[index]
            json.dump(feature, handle, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        handle.write(']}')


def write_shape(output, features, crs, scratch, notices):
    families = {geometry.geom_type.removeprefix("Multi") for geometry, _ in features}
    if len(families) != 1 or not families.issubset({"Point", "LineString", "Polygon"}):
        fail("UNSUPPORTED_CONVERSION_GEOMETRY", "Shapefile requires a single geometry family (points, lines, or polygons).")
    keys = list(dict.fromkeys(key for _, props in features for key in props))
    if len(keys) > 255:
        fail("CONVERSION_LIMIT_EXCEEDED", "Shapefile supports at most 255 attributes.")
    names, field_data, mapping_names = [], [], {}
    for index, key in enumerate(keys):
        candidate = key if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,9}", key) else f"field_{index + 1}"
        if candidate.lower() in {item.lower() for item in names}:
            candidate = f"f_{index + 1}"
            while candidate.lower() in {item.lower() for item in names}:
                candidate = '_' + candidate
        names.append(candidate)
        mapping_names[candidate] = key
        values = [props.get(key) for _, props in features]
        present = [value for value in values if value is not None]
        if present and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in present):
            if any(abs(value) >= 10**15 for value in present):
                fail("UNSUPPORTED_CONVERSION_ATTRIBUTES", "A numeric attribute exceeds reliable DBF precision.")
            field_data.append(np.array([np.nan if value is None else value for value in values], dtype=float))
        else:
            values = [None if value is None else value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(',', ':')) for value in values]
            if any(value is not None and len(value.encode('utf-8')) > 254 for value in values):
                fail("UNSUPPORTED_CONVERSION_ATTRIBUTES", "A text attribute exceeds the Shapefile 254-byte limit.")
            field_data.append(np.array(values, dtype=object))
    if not names:
        names = ['feature_id']
        field_data = [np.arange(1, len(features) + 1, dtype=np.int64)]
    shp = scratch / "converted.shp"
    family = next(iter(families))
    geometry_type = ("Multi" if any(geom.geom_type.startswith("Multi") for geom, _ in features) else "") + family
    if any(geom.has_z for geom, _ in features):
        geometry_type += " Z"
    write(shp, np.array([to_wkb(geom) for geom, _ in features], dtype=object), field_data, names,
          driver="ESRI Shapefile", geometry_type=geometry_type, crs=crs.to_wkt(), encoding="UTF-8")
    if any(a != b for a, b in mapping_names.items()):
        notices.append("SHAPEFILE_FIELD_NAMES_SHORTENED")
    notices.append("SHAPEFILE_DBF_ATTRIBUTE_TYPES")
    (scratch / "conversion-metadata.json").write_text(json.dumps({"crs": crs.to_string(), "fields": mapping_names}, ensure_ascii=False), encoding="utf-8")
    if sum(file.stat().st_size for file in scratch.glob('converted.*')) > MAX_OUTPUT:
        fail('CONVERSION_LIMIT_EXCEEDED', 'The expanded Shapefile output exceeds 500 MiB.')
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(scratch.glob('converted.*')):
            archive.write(file, file.name)
        archive.write(scratch / 'conversion-metadata.json', 'conversion-metadata.json')


def write_dxf(output, features, notices):
    notices.append("DXF_GEOMETRY_ONLY")
    if any(geometry.geom_type in ('Polygon', 'MultiPolygon') for geometry, _ in features):
        notices.append("DXF_POLYGON_RINGS_AS_POLYLINES")
    with output.open('w', encoding='ascii', newline='\n') as handle:
        def pairs(*values):
            handle.write('\n'.join(str(value) for value in values) + '\n')
        pairs(0,'SECTION',2,'HEADER',9,'$ACADVER',1,'AC1015',0,'ENDSEC',0,'SECTION',2,'ENTITIES')
        def line(coords, closed):
            coords = list(coords)
            if closed and coords[0] == coords[-1]:
                coords.pop()
            if len(coords[0]) == 3:
                pairs(0,'POLYLINE',8,'0',66,1,70,8 + int(closed),10,0,20,0,30,0)
                for x,y,z in coords:
                    pairs(0,'VERTEX',8,'0',70,32,10,x,20,y,30,z)
                pairs(0,'SEQEND',8,'0')
            else:
                pairs(0,'LWPOLYLINE',100,'AcDbEntity',8,'0',100,'AcDbPolyline',90,len(coords),70,int(closed))
                for x,y in coords:
                    pairs(10,x,20,y)
        def entity(geom):
            kind = geom.geom_type
            if kind.startswith('Multi'):
                for child in geom.geoms:
                    entity(child)
            elif kind == 'Point':
                coords = geom.coords[0]
                pairs(0,'POINT',100,'AcDbEntity',8,'0',100,'AcDbPoint',10,coords[0],20,coords[1],30,coords[2] if len(coords)>2 else 0)
            elif kind == 'LineString':
                line(geom.coords, geom.is_ring)
            elif kind == 'Polygon':
                line(geom.exterior.coords, True)
                for ring in geom.interiors:
                    line(ring.coords, True)
            else:
                fail("UNSUPPORTED_CONVERSION_GEOMETRY", "Unsupported DXF geometry.")
        for geom, _ in features:
            entity(geom)
        pairs(0,'ENDSEC',0,'EOF')


def convert(config):
    source, output = Path(config['source']), Path(config['output'])
    if source.stat().st_size > MAX_INPUT:
        fail("CONVERSION_LIMIT_EXCEEDED", "The input exceeds 250 MiB.")
    pyogrio.set_gdal_config_options({"PROJ_NETWORK": "OFF", "DXF_CLOSED_LINE_AS_POLYGON": "TRUE", "OGR_ARC_STEPSIZE": "0.1"})
    scratch = output.parent / 'work'
    scratch.mkdir(exist_ok=True)
    features, source_crs, ids = load_input(source, config['inputFormat'], config.get('sourceCRS'), scratch)
    try:
        target_crs = coordinate_system(config.get('targetCRS') or source_crs)
        transformer = coordinate_transformer(source_crs, target_crs)
    except Exception:
        fail("INVALID_TARGET_CRS", "The requested target CRS cannot be used for this conversion.")
    notices = []
    vertices = 0
    converted = []
    for geom, props in features:
        vertices += validate_geometry(geom)
        if vertices > MAX_VERTICES:
            fail("CONVERSION_LIMIT_EXCEEDED", "The file exceeds five million vertices.")
        if source_crs.is_geographic:
            coords = get_coordinates(geom)
            if (np.abs(coords[:,0]) > 180).any() or (np.abs(coords[:,1]) > 90).any():
                fail("INVALID_CONVERSION_COORDINATES", "Source coordinates exceed longitude/latitude bounds.")
        try:
            if not source_crs.equals(target_crs):
                geom = transform(lambda x,y,z=None: transformer.transform(x,y,z,errcheck=True) if z is not None else transformer.transform(x,y,errcheck=True), geom)
        except Exception:
            fail("INVALID_CONVERSION_COORDINATES", "Coordinates cannot be transformed with the selected CRS.")
        validate_geometry(geom)
        if target_crs.is_geographic:
            coords = get_coordinates(geom)
            if (np.abs(coords[:,0]) > 180).any() or (np.abs(coords[:,1]) > 90).any():
                fail("INVALID_CONVERSION_COORDINATES", "Coordinates exceed longitude/latitude bounds. Check the source CRS.")
        converted.append((geom,props))
    target_format = config['targetFormat']
    if target_format != 'geojson' and any(value is not None for value in ids):
        notices.append('FEATURE_IDS_NOT_RETAINED')
    if target_format == 'geojson':
        write_geojson(output, converted, target_crs, ids)
        if not target_crs.equals(coordinate_system('EPSG:4326')):
            notices.append('PROJECTED_GEOJSON_LEGACY_CRS')
    elif target_format == 'shapefile':
        write_shape(output, converted, target_crs, scratch, notices)
    elif target_format == 'dxf':
        write_dxf(output, converted, notices)
    else:
        fail('UNSUPPORTED_CONVERSION_FORMAT', 'Unsupported output format.')
    if output.stat().st_size > MAX_OUTPUT:
        fail('CONVERSION_LIMIT_EXCEEDED', 'The output exceeds 500 MiB.')
    result = {'features':len(converted), 'sourceCRS':source_crs.to_string(), 'targetCRS':target_crs.to_string(), 'warnings':notices}
    (output.parent / 'result.json').write_text(json.dumps(result), encoding='utf-8')


if __name__ == '__main__':
    if sys.platform == 'linux':
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (240, 240))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
        resource.setrlimit(resource.RLIMIT_AS, (3 * 1024**3, 3 * 1024**3))
    try:
        with open(sys.argv[1], encoding='utf-8') as handle:
            config = json.load(handle)
        with warnings.catch_warnings(record=True) as recorded:
            warnings.simplefilter('always')
            convert(config)
            if recorded:
                fail('CONVERSION_DATA_LOSS', 'The GIS driver reported possible data loss; no partial output was accepted.')
    except ConversionError as error:
        print(json.dumps({'code':error.code, 'message':str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print(json.dumps({'code':'INVALID_CONVERSION_FILE', 'message':'The file could not be converted. Check its contents and CRS.'}), file=sys.stderr)
        sys.exit(1)
