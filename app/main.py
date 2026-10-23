import io
import json
import os
import re
import sqlite3
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Any

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
PHOTO_DIR = DATA_DIR / "photos"
PHOTO_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "tips.db"
BUNDLED = Path(__file__).parent / "data"
CATALOG = json.loads((BUNDLED / "catalog.json").read_text())
PROFILES = json.loads((BUNDLED / "profiles.json").read_text())
PRINTERS = {p["name"]: p for p in PROFILES["printers"]}
# Options a system preset doesn't list take the slicer's built-in default, extracted from its source.
BUILTIN = {"process": {}, "filament": {}, "printer": {}}
# catalog kinds are process / filament / printer; shipped profiles call the last one "machine"
OPTION_KIND = {k: kind for kind, pages in CATALOG["kinds"].items()
               for pg in pages for g in pg["groups"] for k in g["options"]}

# Keys that differ between profiles but are identity/metadata, not real overrides.
IGNORED_KEYS = {
    "name", "from", "inherits", "version", "setting_id", "print_settings_id",
    "filament_settings_id", "printer_settings_id", "is_custom_defined",
    "compatible_printers", "compatible_printers_condition", "instantiation",
    "type", "print_extruder_id", "print_extruder_variant",
}


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.execute(
            """CREATE TABLE IF NOT EXISTS tips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                slicers TEXT NOT NULL DEFAULT '[]',
                printer TEXT NOT NULL DEFAULT '',
                filament TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                source_url TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                photo TEXT NOT NULL DEFAULT '',
                settings TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        cols = {r["name"] for r in con.execute("PRAGMA table_info(tips)")}
        if "base_printer" not in cols:
            con.execute("ALTER TABLE tips ADD COLUMN base_printer TEXT NOT NULL DEFAULT ''")


init_db()
app = FastAPI(title="Slicer Tips")


class Setting(BaseModel):
    key: str
    value: Any  # profile-native: a string, or a list of strings for per-extruder/filament options
    kind: str = ""


class TipIn(BaseModel):
    title: str
    slicers: list[str] = []
    printer: str = ""
    base_printer: str = ""
    filament: str = ""
    tags: list[str] = []
    source_url: str = ""
    notes: str = ""
    settings: list[Setting] = []


def row_to_tip(r):
    d = dict(r)
    for k in ("slicers", "tags", "settings"):
        d[k] = json.loads(d[k])
    for st in d["settings"]:
        st.setdefault("kind", kind_of(st["key"], d["base_printer"]))
    return d


for _kind, _pages in CATALOG["kinds"].items():
    for _pg in _pages:
        for _g in _pg["groups"]:
            for _k in _g["options"]:
                if "default" in CATALOG["options"][_k]:
                    BUILTIN[_kind][_k] = CATALOG["options"][_k]["default"]


def kind_of(key: str, base_printer: str = "") -> str:
    if key in OPTION_KIND:
        return OPTION_KIND[key]
    d = printer_defaults(base_printer) if base_printer in PRINTERS else {}
    for kind in ("printer", "filament", "process"):
        if key in d.get(kind, {}):
            return kind
    return "process"


def values(t: TipIn):
    settings = [{**s.model_dump(), "kind": s.kind or kind_of(s.key, t.base_printer)}
                for s in t.settings if s.key.strip()]
    return (
        t.title.strip(), json.dumps(t.slicers), t.printer, t.base_printer, t.filament,
        json.dumps([x.strip() for x in t.tags if x.strip()]), t.source_url, t.notes,
        json.dumps(settings),
    )


@app.get("/api/tips")
def list_tips():
    with db() as con:
        rows = con.execute("SELECT * FROM tips ORDER BY id DESC").fetchall()
    return [row_to_tip(r) for r in rows]


@app.post("/api/tips")
def create_tip(t: TipIn):
    with db() as con:
        cur = con.execute(
            "INSERT INTO tips (title,slicers,printer,base_printer,filament,tags,source_url,notes,settings) VALUES (?,?,?,?,?,?,?,?,?)",
            values(t),
        )
        return row_to_tip(con.execute("SELECT * FROM tips WHERE id=?", (cur.lastrowid,)).fetchone())


@app.put("/api/tips/{tip_id}")
def update_tip(tip_id: int, t: TipIn):
    with db() as con:
        cur = con.execute(
            "UPDATE tips SET title=?,slicers=?,printer=?,base_printer=?,filament=?,tags=?,source_url=?,notes=?,settings=? WHERE id=?",
            (*values(t), tip_id),
        )
        if not cur.rowcount:
            raise HTTPException(404)
        return row_to_tip(con.execute("SELECT * FROM tips WHERE id=?", (tip_id,)).fetchone())


@app.delete("/api/tips/{tip_id}")
def delete_tip(tip_id: int):
    with db() as con:
        r = con.execute("SELECT photo FROM tips WHERE id=?", (tip_id,)).fetchone()
        if not r:
            raise HTTPException(404)
        if r["photo"]:
            (PHOTO_DIR / r["photo"]).unlink(missing_ok=True)
        con.execute("DELETE FROM tips WHERE id=?", (tip_id,))
    return {"ok": True}


@app.post("/api/tips/{tip_id}/photo")
async def upload_photo(tip_id: int, file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        raise HTTPException(400, "Unsupported image type")
    name = f"{uuid.uuid4().hex}{ext}"
    (PHOTO_DIR / name).write_bytes(await file.read())
    with db() as con:
        r = con.execute("SELECT photo FROM tips WHERE id=?", (tip_id,)).fetchone()
        if not r:
            (PHOTO_DIR / name).unlink(missing_ok=True)
            raise HTTPException(404)
        if r["photo"]:
            (PHOTO_DIR / r["photo"]).unlink(missing_ok=True)
        con.execute("UPDATE tips SET photo=? WHERE id=?", (name, tip_id))
    return {"photo": name}


@app.get("/photos/{name}")
def get_photo(name: str):
    p = PHOTO_DIR / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


def printer_defaults(name: str) -> dict:
    """Resolved default presets for a system printer: {process, filament, printer}."""
    p = PRINTERS.get(name)
    if not p:
        raise HTTPException(404, "Unknown printer")
    return {
        "process": {**BUILTIN["process"], **PROFILES["process"][p["process"]]},
        "filament": {**BUILTIN["filament"], **PROFILES["filament"][p["filament"]]},
        "printer": {**BUILTIN["printer"], **PROFILES["machine"][name]},
    }


@app.get("/api/catalog")
def get_catalog():
    return CATALOG


@app.get("/api/printers")
def list_printers():
    return PROFILES["printers"]


@app.get("/api/printers/{name}/defaults")
def get_defaults(name: str):
    return printer_defaults(name)


def same(a, b) -> bool:
    """Profile value equality: numeric strings compare as numbers; lists compare over their common length
    (a project config carries one entry per loaded filament, system presets only a couple)."""
    if isinstance(a, list) or isinstance(b, list):
        la = a if isinstance(a, list) else [a]
        lb = b if isinstance(b, list) else [b]
        n = min(len(la), len(lb))
        return (n > 0 or not la and not lb) and all(same(x, y) for x, y in zip(la[:n], lb[:n]))
    a, b = str(a), str(b)
    if a == b:
        return True
    try:
        return float(a) == float(b)
    except ValueError:
        return False


def load_profile(name: str, data: bytes) -> dict:
    """Load a flat settings dict from a profile .json, or a .3mf (Orca/Bambu project_settings.config)."""
    try:
        if name.lower().endswith(".3mf"):
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                member = next(
                    (n for n in z.namelist() if n.endswith("project_settings.config")), None
                )
                if not member:
                    raise ValueError("No project_settings.config in 3MF")
                data = z.read(member)
        obj = json.loads(data)
    except (ValueError, zipfile.BadZipFile) as e:
        raise HTTPException(400, f"Cannot parse {name}: {e}")
    if not isinstance(obj, dict):
        raise HTTPException(400, f"{name}: expected a JSON object")
    return obj


@app.post("/api/diff")
async def diff(
    profile: UploadFile = File(...),
    baseline: UploadFile | None = File(None),
    printer: str = Form(""),
):
    """Settings in `profile` that differ from `baseline` (a file) or from a system printer's defaults.

    With a printer baseline only options known to the catalog are kept, so a whole project
    config doesn't drag in hundreds of printer-specific keys.
    """
    p = load_profile(profile.filename or "", await profile.read())
    known_only = False
    if baseline and baseline.filename:
        b = load_profile(baseline.filename, await baseline.read())
    elif printer:
        d = printer_defaults(printer)
        b = {**d["printer"], **d["process"], **d["filament"]}
        known_only = True
    else:
        b = {}
    out = [
        {"key": k, "value": v, "kind": kind_of(k, printer)}
        for k, v in p.items()
        if k not in IGNORED_KEYS and (not known_only or k in OPTION_KIND)
        and (k not in b or not same(v, b[k]))
    ]
    return {"settings": out, "total_keys": len(p)}


@app.get("/api/tips/{tip_id}/export")
def export_tip(tip_id: int, kind: str = "process"):
    """Export one kind of a recipe's overrides as a user preset that inherits the printer's default."""
    if kind not in ("process", "filament", "printer"):
        raise HTTPException(400, "kind must be process, filament or printer")
    with db() as con:
        r = con.execute("SELECT * FROM tips WHERE id=?", (tip_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    t = row_to_tip(r)
    prof = {"type": "machine" if kind == "printer" else kind, "name": f'{t["title"]} ({kind})',
            "from": "User", "instantiation": "true"}
    p = PRINTERS.get(t["base_printer"])
    if p:
        prof["inherits"] = {"process": p["process"], "filament": p["filament"], "printer": p["name"]}[kind]
    prof.update({s["key"]: s["value"] for s in t["settings"] if s["kind"] == kind})
    fname = re.sub(r"[^\w.-]+", "_", f'{t["title"]}_{kind}') or "tip"
    return JSONResponse(prof, headers={"Content-Disposition": f'attachment; filename="{fname}.json"'})


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
