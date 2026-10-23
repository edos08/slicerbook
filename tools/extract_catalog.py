#!/usr/bin/env python3
"""Build app/data/catalog.json from an OrcaSlicer source checkout.

Usage: extract_catalog.py <orca-checkout> <out.json>

Reads the tab layout (pages/groups/option keys) from src/slic3r/GUI/Tab.cpp and the
option definitions (label, tooltip, type, limits, enums) from src/libslic3r/PrintConfig.cpp.
OrcaSlicer is AGPL-3.0; the generated catalog is derived from its source.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

# (kind, function marker in Tab.cpp). Each section runs until the next `Tab...::` function.
BUILDERS = [
    ("process", "void TabPrint::build()"),
    ("filament", "void TabFilament::build()"),
    ("printer", "void TabPrinter::build_fff()"),
    ("printer", "void TabPrinter::extruders_count_changed("),
    ("printer", "void TabPrinter::build_unregular_pages("),
]
PRINTER_PAGE_ORDER = ["Basic information", "Machine G-code", "Motion ability", "Multimaterial", "Extruder", "Notes"]

STR = r'"((?:[^"\\]|\\.)*)"'


def unescape(s):
    s = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), s)
    return s.replace(r"\n", "\n").replace(r"\"", '"').replace(r"\\", "\\")


def literals(expr):
    return unescape("".join(re.findall(STR, expr)))


def parse_defs(src):
    """key -> definition dict, from `def = this->add("key", coType);` blocks."""
    out = {}
    blocks = re.split(r'\n\s*def\s*=\s*this->add(?:_nullable)?\(\s*"', src)[1:]
    for b in blocks:
        m = re.match(r'(\w+)"\s*,\s*(\w+)\s*\)', b)
        if not m:
            continue
        key, typ = m.groups()
        d = {"type": typ}
        body = b[m.end():].split("\n\n")[0] if False else b[m.end():]
        for field in ("label", "tooltip", "sidetext", "category"):
            fm = re.search(rf"def->{field}\s*=\s*([^;]*);", body)
            if fm:
                d[field] = literals(fm.group(1))
        for field in ("min", "max"):
            fm = re.search(rf"def->{field}\s*=\s*(-?[\d.]+)\s*;", body)
            if fm:
                d[field] = float(fm.group(1))
        vals = re.findall(r"enum_values\.push_back\(\s*" + STR, body)
        labels = [literals(x) for x in re.findall(r"enum_labels\.push_back\(([^;]*)\);", body)]
        if vals:
            d["enum"] = [{"value": unescape(v), "label": labels[i] if i < len(labels) else unescape(v)}
                         for i, v in enumerate(vals)]
        if re.search(r"def->multiline\s*=\s*true", body):
            d["multiline"] = True
        out[key] = d
    return out


def function_ranges(lines):
    starts = [i for i, l in enumerate(lines) if re.match(r"^(void|bool|int|static [\w:<>]+|[\w:<>]+) \w*Tab\w*::\w+\(", l)]
    return starts


def parse_layout(lines, marker, defs):
    starts = function_ranges(lines)
    begin = next(i for i, l in enumerate(lines) if l.startswith(marker.split("(")[0] + "(") and marker.split("(")[0] in l)
    end = next((s for s in starts if s > begin), len(lines))
    pages = []
    for l in lines[begin:end]:
        code = l.split("//")[0]
        m = re.search(r'add_options_page\(\s*(?:L\("([^"]*)"\)|(\w+))', code)
        if m:
            # non-literal titles (page_name) are the per-extruder pages
            pages.append({"title": m.group(1) or "Extruder", "groups": []})
            continue
        m = re.search(r'new_optgroup\(\s*L\("([^"]*)"\)', code)
        if m and pages:
            pages[-1]["groups"].append({"title": m.group(1), "options": []})
            continue
        if pages and pages[-1]["groups"]:
            for key in re.findall(r'(?:get_option|append_single_option_line)\(\s*"(\w+)"', code):
                if key in defs and key not in pages[-1]["groups"][-1]["options"]:
                    pages[-1]["groups"][-1]["options"].append(key)
    return pages


def main(orca, out):
    orca = Path(orca)
    defs = parse_defs((orca / "src/libslic3r/PrintConfig.cpp").read_text(errors="replace"))
    lines = (orca / "src/slic3r/GUI/Tab.cpp").read_text(errors="replace").splitlines()
    kinds = {}
    for kind, marker in BUILDERS:
        pages = parse_layout(lines, marker, defs)
        for p in pages:
            if not any(g["options"] for g in p["groups"]):
                continue
            existing = next((q for q in kinds.setdefault(kind, []) if q["title"] == p["title"]), None)
            if existing:
                known = {g["title"] for g in existing["groups"]}
                existing["groups"].extend(g for g in p["groups"] if g["title"] not in known)
            else:
                kinds[kind].append(p)
    # Per-axis limits are defined in a loop in PrintConfig.cpp ("machine_max_speed_" + axis).
    for ax in "xyze":
        for what, unit, tip in (("speed", "mm/s", "Maximum speed of {} axis"),
                                ("acceleration", "mm/s\u00b2", "Maximum acceleration of the {} axis"),
                                ("jerk", "mm/s", "Maximum jerk of the {} axis")):
            defs[f"machine_max_{what}_{ax}"] = {
                "type": "coFloats", "label": f"Maximum {what} {ax.upper()}",
                "tooltip": tip.format(ax.upper()), "sidetext": unit, "min": 0.0}
    # Motion ability keys are built in a loop over variable names, so add them by prefix.
    motion = [k for k in defs if re.match(r"machine_(max|min)_(speed|acceleration|jerk|junction)|machine_(max|min)_\w+$", k)
              and not k.endswith("_gcode")]
    kinds["printer"].append({"title": "Motion ability", "groups": [{"title": "Limits", "options": sorted(motion)}]})
    kinds["printer"].sort(key=lambda p: PRINTER_PAGE_ORDER.index(p["title"]) if p["title"] in PRINTER_PAGE_ORDER else 99)
    used = {k for pages in kinds.values() for p in pages for g in p["groups"] for k in g["options"]}
    tag = subprocess.run(["git", "-C", str(orca), "describe", "--tags"], capture_output=True, text=True).stdout.strip()
    Path(out).write_text(json.dumps({
        "source": f"OrcaSlicer {tag}",
        "kinds": kinds,
        "options": {k: defs[k] for k in sorted(used)},
    }, indent=1, ensure_ascii=False))
    for kind, pages in kinds.items():
        print(kind, [(p["title"], sum(len(g["options"]) for g in p["groups"])) for p in pages])
    print(len(used), "options")


if __name__ == "__main__":
    main(*sys.argv[1:3])
