#!/usr/bin/env python3
"""Build app/data/profiles.json from OrcaSlicer's shipped system profiles.

Usage: extract_profiles.py <orca-checkout> <out.json> [vendor ...]   (default vendor: BBL)

Each system preset is flattened by following its `inherits` chain, so a printer's
default machine / process / filament settings can be shown in full.
"""
import json
import sys
from pathlib import Path


def load_dir(d):
    out = {}
    for f in sorted(Path(d).glob("*.json")):
        try:
            j = json.loads(f.read_text())
        except ValueError:
            continue
        if isinstance(j, dict) and "name" in j:
            out[j["name"]] = j
    return out


def flatten(name, index, seen=()):
    j = index[name]
    base = {}
    parent = j.get("inherits")
    if parent and parent in index and parent not in seen:
        base = flatten(parent, index, seen + (name,))
    merged = {**base, **{k: v for k, v in j.items() if k != "inherits"}}
    return merged


def main(orca, out, vendors):
    root = Path(orca) / "resources/profiles"
    result = {"printers": [], "machine": {}, "process": {}, "filament": {}}
    lib = load_dir(root / "OrcaFilamentLibrary/filament")
    for vendor in vendors:
        idx = {k: load_dir(root / vendor / k) for k in ("machine", "process", "filament")}
        idx["filament"] = {**lib, **idx["filament"]}
        for name, m in idx["machine"].items():
            if m.get("instantiation") != "true":
                continue
            flat = flatten(name, idx["machine"])
            proc = m.get("default_print_profile") or flat.get("default_print_profile")
            fil = flat.get("default_filament_profile") or []
            fil = fil[0] if isinstance(fil, list) and fil else fil
            if fil not in idx["filament"] and "Bambu PLA Basic @base" in idx["filament"]:
                fil = "Bambu PLA Basic @base"  # some printers reference a filament variant that isn't shipped
            if proc not in idx["process"] or fil not in idx["filament"]:
                print("skip (missing default preset):", name, proc, fil)
                continue
            result["machine"][name] = flat
            result["process"].setdefault(proc, flatten(proc, idx["process"]))
            result["filament"].setdefault(fil, flatten(fil, idx["filament"]))
            result["printers"].append({
                "name": name, "vendor": vendor, "model": flat.get("printer_model", ""),
                "variant": flat.get("printer_variant", ""), "process": proc, "filament": fil})
    Path(out).write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
    print(len(result["printers"]), "printers,", len(result["process"]), "process,", len(result["filament"]), "filament presets")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:] or ["BBL"])
