"""Shared CRS transformation primitives for CAD ingest and standalone conversion."""
from pyproj import CRS, Transformer
from shapely.ops import transform


def coordinate_system(value):
    crs = CRS.from_user_input(value)
    if not (crs.is_geographic or crs.is_projected):
        raise ValueError("Choose a geographic or projected coordinate system.")
    return crs


def coordinate_transformer(source, target):
    return Transformer.from_crs(coordinate_system(source), coordinate_system(target),
                                always_xy=True, allow_ballpark=False)


def reproject(geometry, from_crs, to_crs):
    transformer = coordinate_transformer(from_crs, to_crs)
    return transform(lambda x, y, z=None: transformer.transform(x, y, z, errcheck=True)
                     if z is not None else transformer.transform(x, y, errcheck=True), geometry)
