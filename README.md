# Scan-to-3D furniture assembly

Photograph or upload a flat-pack manual; the server reads it with a vision model and the
app plays each step as a 3D animation built from part templates and a mate solver.

## Layout

| Path | What it is |
|---|---|
| `server/` | FastAPI server: page prep, extraction passes (`pipeline.py`), model providers, validator |
| `web/` | The app (Three.js player, templates, resolver, mate solver, geometry worker) |
| `ios/FurnitureAR/` | Xcode project: native iPhone wrapper that loads the app from the server |
| `samples/` | The RTA-0097M chair manual used for testing |
| `demo/` | Earlier standalone demos |

## Run the server (on the Mac)

```bash
.venv/bin/python server/app.py
```

It listens on port 8765 on all interfaces. Open http://localhost:8765 on the Mac, or
`http://<mac-ip>:8765` from a phone on the same Wi-Fi.

Settings live in `.env` (never committed, never sent to the browser):

| Key | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | Google AI Studio key |
| `MODEL_PROVIDER` | `gemini` | Model backend |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Model name |
| `VOTES` | `3` | Runs per step for the majority vote |

Plans are cached by file hash in `server/jobs/cache/`, so re-scanning the same manual
costs nothing. Tick "Re-read with the model" to force a fresh run.

Command-line extraction: `.venv/bin/python server/extract_cli.py samples/rta-0097m.pdf out.json`

## Install on an iPhone

1. Start the server on the Mac (above).
2. Open `ios/FurnitureAR/FurnitureAR.xcodeproj` in Xcode.
3. Select the FurnitureAR target → Signing & Capabilities → choose your Team (a free Apple ID works).
4. Plug in the iPhone, pick it as the run destination, press Run.
5. On the phone: allow Local Network access. First run with a free Apple ID: Settings → General →
   VPN & Device Management → trust your developer certificate.
6. If the Mac's IP changes, long-press anywhere in the app to change the server address.

## IKEA kit player

Open `/kits.html` on the running server. The six research kits are read from
`samples/ikea-kits/catalog.json`. Select a kit to inspect its finished GLB, then
upload its manual to generate the timeline. New scans need the Gemini SDK,
pypdfium2, and a configured Gemini key. Exact PDF copies are matched by hash.

Gemini proposes the step-to-node mapping. Compare it with the displayed manual
and review any unresolved items before recording. Movement uses illustrative
approach paths and the browser exports MP4 when available or WebM otherwise.

The comparison panel imports a Manual-PA prediction export aligned to the GLB
coordinate frame. It does not run Manual-PA. Its input format is shown in the
panel. For a genuine run, use compatible checkpoints and an exporter that maps
predictions to the GLB node indices.

`supabase/ikea-kits.sql` prepares private cloud storage and metadata for the
research kits. The player currently serves the local copies.
