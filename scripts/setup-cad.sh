#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime="$root/.cad-runtime"
mkdir -p "$runtime"
python3 -m pip install --target "$runtime/python" -r "$root/scripts/cad-requirements.txt"
if [[ ! -x "$runtime/bin/dwgread" ]]; then
  build_dir=$(mktemp -d)
  trap 'rm -rf -- "$build_dir"' EXIT
  curl --fail --location --max-time 180 https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz -o "$build_dir/source.tar.xz"
  (cd "$build_dir" && echo '83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e  source.tar.xz' | sha256sum --check)
  mkdir "$build_dir/source"
  tar -xf "$build_dir/source.tar.xz" -C "$build_dir/source" --strip-components=1
  (
    cd "$build_dir/source"
    ./configure --prefix="$runtime" --disable-shared --disable-bindings --disable-docs
    make -j2
    make install
  )
fi
PYTHONPATH="$runtime/python" OPENBLAS_NUM_THREADS=1 python3 -c 'import pyogrio; print("GDAL:", pyogrio.__gdal_version_string__); print("CAD drivers:", {k:v for k,v in pyogrio.list_drivers().items() if k in ["DWG", "CAD", "DGN", "DGNv8"]})'
"$runtime/bin/dwgread" --version
