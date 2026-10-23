# Slicerbook

A small self-hosted cookbook for the slicer tweaks you see in 3D printing videos ("set support Z distance to 0.15 and use grid interface…"). Save each tip as a card, browse and search later, and export it as an importable process preset.

- Cards with title, setting overrides (key/value), slicers tested on, printer, filament, tags, notes, photo and source link
- Search and filter by slicer or tag
- Extract overrides by diffing a profile `.json` or `.3mf` (OrcaSlicer / Bambu Studio) against an optional baseline
- Export a tip as a process preset JSON
- Single container, SQLite, no external services

## Run

```sh
docker compose up -d
```

Open http://localhost:8000. Data (database and photos) lives in `./data`.

## Develop

```sh
pip install -r requirements.txt
DATA_DIR=./data uvicorn app.main:app --reload
```

## Notes

- There is no authentication; run it on a trusted network or behind a reverse proxy.
- Exported presets contain only the overrides. Set `inherits` to your base preset after importing if you want it chained.
- Setting keys are stored as-is. Some keys exist only in OrcaSlicer, not Bambu Studio.
