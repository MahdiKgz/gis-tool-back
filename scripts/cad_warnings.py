"""Bounded, explicit policy for recoverable GDAL CAD diagnostics."""
import re


POLYGON_FALLBACK = (
    "organizePolygons() received an unexpected geometry.  Either a polygon with "
    "interior rings, or a polygon with less than 4 points, or a non-Polygon "
    "geometry.  Return arguments as a collection."
)


class CadWarnings:
    def __init__(self):
        self.items = {}
        self.partial = False
        self.unsupported = False

    def capture(self, message, category, filename, lineno, file=None, line=None):
        text = str(message).strip()
        if not issubclass(category, RuntimeWarning):
            self.unsupported = True
            return
        if text == POLYGON_FALLBACK:
            code = "CAD_POLYGON_FALLBACK"
            description = "Some polygon boundaries were read using a geometry fallback; review their topology."
        elif re.fullmatch(r"Block [^\r\n]{1,255} does not exist", text):
            code = "CAD_MISSING_BLOCK"
            description = text + "; its contents could not be imported."
            self.partial = True
        else:
            self.unsupported = True
            return
        key = (code, description)
        if key in self.items:
            self.items[key]["occurrences"] += 1
        elif len(self.items) < 100:
            self.items[key] = {"code": code, "message": description, "occurrences": 1}
        else:
            self.unsupported = True

    def report(self, source_crs):
        return {
            "sourceCrs": source_crs, "targetCrs": "EPSG:4326",
            "partial": self.partial, "warnings": list(self.items.values()),
        }
