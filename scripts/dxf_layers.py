"""Read the layer table of a text DXF, including layers without entities."""
import codecs
import re


def dxf_text_encoding(path):
    with path.open("rb") as probe:
        header = probe.read(65536)
    if header.startswith(b"AutoCAD Binary DXF"):
        return None
    version = re.search(rb"\$ACADVER\s+1\s+AC(\d+)", header)
    codepage = re.search(rb"\$DWGCODEPAGE\s+3\s+ANSI_(\d+)", header)
    encoding = "utf-8" if version and int(version[1]) >= 1021 else (
        "cp" + codepage[1].decode("ascii") if codepage else "cp1252"
    )
    try:
        codecs.lookup(encoding)
    except LookupError:
        return None
    return encoding


def decode_layer_name(value):
    name = re.sub(r"\\U\+([0-9A-Fa-f]{4})", lambda item: chr(int(item[1], 16)), value)
    return name.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def text_dxf_layers(path):
    encoding = dxf_text_encoding(path)
    if encoding is None:
        return []
    layers = []
    current_layer_record = False
    with path.open(encoding=encoding, errors="replace") as source:
        for raw_code, raw_value in zip(source, source):
            code, value = raw_code.strip(), raw_value.rstrip("\r\n")
            if code == "2" and value.strip() == "ENTITIES":
                break
            if code == "0":
                current_layer_record = value.strip() == "LAYER"
            elif current_layer_record and code == "2":
                name = decode_layer_name(value)
                if name and "\ufffd" not in name and not re.search(r"[\ud800-\udfff]", name):
                    layers.append(name)
                current_layer_record = False
    return list(dict.fromkeys(layers))
