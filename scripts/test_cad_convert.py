"""Native GDAL tests. Replace only the DWG decoder, feed real synthetic DXF."""
import contextlib
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import warnings

import cad_convert
from cad_warnings import CadWarnings


# One real point and a referenced block absent from the BLOCKS section.
DXF = """0
SECTION
2
HEADER
9
$ACADVER
1
AC1015
0
ENDSEC
0
SECTION
2
ENTITIES
0
POINT
8
survey
10
500000
20
3900000
0
INSERT
8
symbols
2
MissingSymbol
10
500100
20
3900100
0
ENDSEC
0
EOF
"""


class ConverterTests(unittest.TestCase):
    def test_missing_block_keeps_readable_geometry_and_durable_diagnostics(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "drawing.dwg"
            source.write_text(DXF)
            target = Path(directory) / "output.geojson"

            def decode(args, **kwargs):
                shutil.copyfile(source, args[4])
                return subprocess.CompletedProcess(args, 0, stderr=b"SUCCESS")

            policy = CadWarnings()
            with patch.object(cad_convert.subprocess, "run", side_effect=decode), \
                 patch.object(cad_convert.pyogrio, "list_drivers", return_value={"DXF": "rw"}), \
                 warnings.catch_warnings(), contextlib.redirect_stdout(io.StringIO()):
                warnings.simplefilter("always")
                warnings.showwarning = policy.capture
                cad_convert.convert(source, target, "EPSG:32639", "dwgread", policy)
            data = json.loads(target.read_text())
            self.assertEqual(len(data["features"]), 1)
            self.assertAlmostEqual(data["features"][0]["geometry"]["coordinates"][0], 51, places=5)
            self.assertTrue(data["snapgisCadImport"]["partial"])
            self.assertEqual(data["snapgisCadImport"]["warnings"][0]["code"], "CAD_MISSING_BLOCK")

    def test_unknown_gdal_warning_prevents_output_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "drawing.dgn"
            source.write_bytes(b"fixture")
            target = Path(directory) / "output.geojson"

            def read(*args, **kwargs):
                warnings.warn("Unexpected end of geometry data", RuntimeWarning)
                return {"fields": []}, [1], [bytes.fromhex("010100000000000000000049400000000000804140")], []

            policy = CadWarnings()
            with patch.object(cad_convert.pyogrio, "list_layers", return_value=[("entities", "Point")]), \
                 patch.object(cad_convert.pyogrio, "read_info", return_value={"driver": "DGN"}), \
                 patch.object(cad_convert, "read", side_effect=read), warnings.catch_warnings(), \
                 contextlib.redirect_stderr(io.StringIO()) as stderr:
                warnings.simplefilter("always")
                warnings.showwarning = policy.capture
                with self.assertRaises(SystemExit):
                    cad_convert.convert(source, target, "EPSG:4326", "dwgread", policy)
            self.assertIn("CAD_CONVERSION_WARNING", stderr.getvalue())
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
