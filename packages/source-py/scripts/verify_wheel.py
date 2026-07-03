#!/usr/bin/env python3
"""Fail the release if the built wheel is missing package code or the web UI.

The wheel bundles two things that can silently go missing:
  1. the ``horus_source`` package (a hatch config regression once produced a
     metadata-only wheel), and
  2. the compiled React frontend under ``web/frontend/dist/`` — it is git-ignored
     and rebuilt by ``npm run build`` in CI, so a failed/empty frontend build
     would otherwise publish a UI-less wheel that only shows the "UI not built"
     fallback page.

Usage: python scripts/verify_wheel.py [dist_dir]  (default: dist)
"""

from __future__ import annotations

import pathlib
import sys
import zipfile

MIN_PY_FILES = 20


def main() -> int:
    dist_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    wheels = [p for p in dist_dir.iterdir() if p.suffix == ".whl"]
    if not wheels:
        print(f"ERROR: no .whl found in {dist_dir}/")
        return 1
    whl = wheels[0]

    with zipfile.ZipFile(whl) as z:
        names = z.namelist()

    py_files = [n for n in names if n.endswith(".py")]
    frontend = [n for n in names if "/web/frontend/dist/" in n]
    has_index = any(n.endswith("/web/frontend/dist/index.html") for n in names)
    assets = [n for n in frontend if "/assets/" in n]

    print(f"Wheel: {whl.name} ({whl.stat().st_size // 1024} KB)")
    print(f"  python files: {len(py_files)}")
    print(f"  frontend dist files: {len(frontend)} (index.html: {has_index}, assets: {len(assets)})")

    errors: list[str] = []
    if len(py_files) < MIN_PY_FILES:
        errors.append(f"only {len(py_files)} .py files (< {MIN_PY_FILES}) — package code missing")
    if not has_index:
        errors.append("web/frontend/dist/index.html missing — frontend was not built into the wheel")
    if not assets:
        errors.append("web/frontend/dist/assets/* missing — frontend build produced no assets")

    if errors:
        for e in errors:
            print(f"ERROR: {e}")
        print("Aborting publish.")
        return 1

    print("OK: wheel contains package code and the built frontend.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
