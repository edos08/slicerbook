# Slicerbook

A small self-hosted "time machine" for slicer settings. Pick a Bambu Lab printer, tweak settings in a familiar
Print / Filament / Printer editor (no model view), and save the result as a snapshot. Every snapshot stores only what
differs from that printer's default presets, and the differences are highlighted, so a tip from a video is just a few
visible lines instead of 400 keys buried in a preset.

- Settings editor laid out like OrcaSlicer's tabs: Print, Filament, Printer (including the machine G-code editors)
- Defaults come from the shipped system presets of the chosen printer; changed values are highlighted with their default
- Snapshot cards with photo, notes, tags, source link, slicer and filament; search across settings and notes
- Import a profile `.json` or `.3mf` and keep only what differs from the printer defaults (or from a baseline file)
- Export each part (Print / Filament / Printer) as a user preset that `inherits` the printer's default preset
- Single container, SQLite, no external services

Classic settings only: the catalog covers the options OrcaSlicer lays out in its tabs, not printer-specific extras.

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

## Regenerating the settings data

`app/data/catalog.json` (tabs, groups, labels, tooltips) and `app/data/profiles.json` (printer defaults) are generated
from an OrcaSlicer checkout (currently v2.4.2):

```sh
python tools/extract_catalog.py  <orca-checkout> app/data/catalog.json
python tools/extract_profiles.py <orca-checkout> app/data/profiles.json BBL
```

## License

OrcaSlicer is AGPL-3.0 and the generated data is derived from its source, so this project should be AGPL-3.0 too.
The repo is currently marked MIT and needs to be relicensed before it is made public.
