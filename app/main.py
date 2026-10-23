import io
import json
import os
import re
import sqlite3
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
PHOTO_DIR = DATA_DIR / "photos"
PHOTO_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "tips.db"

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


init_db()
app = FastAPI(title="Slicer Tips")


class Setting(BaseModel):
    key: str
    value: str


class TipIn(BaseModel):
    title: str
    slicers: list[str] = []
    printer: str = ""
    filament: str = ""
    tags: list[str] = []
    source_url: str = ""
    notes: str = ""
    settings: list[Setting] = []


def row_to_tip(r):
    d = dict(r)
    for k in ("slicers", "tags", "settings"):
        d[k] = json.loads(d[k])
    return d


def values(t: TipIn):
    return (
        t.title.strip(), json.dumps(t.slicers), t.printer, t.filament,
        json.dumps([x.strip() for x in t.tags if x.strip()]), t.source_url, t.notes,
        json.dumps([s.model_dump() for s in t.settings if s.key.strip()]),
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
            "INSERT INTO tips (title,slicers,printer,filament,tags,source_url,notes,settings) VALUES (?,?,?,?,?,?,?,?)",
            values(t),
        )
        return row_to_tip(con.execute("SELECT * FROM tips WHERE id=?", (cur.lastrowid,)).fetchone())


@app.put("/api/tips/{tip_id}")
def update_tip(tip_id: int, t: TipIn):
    with db() as con:
        cur = con.execute(
            "UPDATE tips SET title=?,slicers=?,printer=?,filament=?,tags=?,source_url=?,notes=?,settings=? WHERE id=?",
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


def stringify(v):
    return v if isinstance(v, str) else json.dumps(v, separators=(",", ":"))


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
    return {k: stringify(v) for k, v in obj.items()}


@app.post("/api/diff")
async def diff(profile: UploadFile = File(...), baseline: UploadFile | None = File(None)):
    """Return settings in `profile` that differ from `baseline` (or all, if no baseline)."""
    p = load_profile(profile.filename or "", await profile.read())
    b = load_profile(baseline.filename or "", await baseline.read()) if baseline and baseline.filename else {}
    out = [
        {"key": k, "value": v}
        for k, v in p.items()
        if k not in IGNORED_KEYS and (k not in b or b[k] != v)
    ]
    return {"settings": out, "total_keys": len(p)}


@app.get("/api/tips/{tip_id}/export")
def export_tip(tip_id: int):
    with db() as con:
        r = con.execute("SELECT * FROM tips WHERE id=?", (tip_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    t = row_to_tip(r)
    # Minimal user process preset: the overrides only, inheriting the slicer's defaults.
    # Set `inherits` to your base preset name after importing if you want it chained.
    prof = {"type": "process", "name": t["title"], "from": "User", "instantiation": "true"}
    prof.update({s["key"]: s["value"] for s in t["settings"]})
    fname = re.sub(r"[^\w.-]+", "_", t["title"]) or "tip"
    return JSONResponse(prof, headers={"Content-Disposition": f'attachment; filename="{fname}.json"'})


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
