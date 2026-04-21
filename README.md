# Salesforce → Tigerpaw CSV Converter

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![Publish Docker image to GHCR](https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter/actions/workflows/docker-publish.yml)

A small Flask + React web app that converts Salesforce CSV exports into
Tigerpaw-ready imports. Drop a file, preview the transform, download the
converted CSV. Ships as a single Docker image for Unraid / Docker / Compose.

- 📖 [Step-by-step Scribe guide](https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ)
- 📝 [CHANGELOG](CHANGELOG.md)

---

## Features

- **Drag-and-drop** upload with live `/api/preview` — see exactly what will
  be renamed, kept, added, or dropped **before** you download.
- **Original ↔ Converted** tabbed tables with row search and highlighted columns.
- **Dark / light** theme with keyboard shortcuts (`⌘/Ctrl+Enter` to convert,
  `Esc` to reset).
- **BOM + CRLF** output so Excel and Tigerpaw both import cleanly — no more
  "open in Excel and re-save" workaround.
- **Safe by default**: 10 MB upload cap, encoding sniffed without loading
  the whole file, fail-fast `SECRET_KEY` in production, non-root container.
- **One-container deploy**: multi-stage Docker image (Node builds the SPA →
  Python runs Gunicorn) with a `/api/health` HEALTHCHECK.

---

## Run on Unraid / Docker (GHCR)

The image is published to GitHub Container Registry on every push:

```
ghcr.io/btoth525/salesforce-to-tigerpaw-converter:latest
```

### Unraid — Add Container (Advanced View)

| Field | Value |
| --- | --- |
| **Name** | `salesforce-to-tigerpaw` |
| **Repository** | `ghcr.io/btoth525/salesforce-to-tigerpaw-converter:latest` |
| **Network Type** | `Bridge` |
| **WebUI** | `http://[IP]:[PORT:5023]/` |
| **Port** — WebUI | Container `5023` → Host `5023` (TCP) |
| **Variable** — `SECRET_KEY` | *any long random string*, e.g. output of `openssl rand -hex 32` |
| **Variable** — `FLASK_ENV` | `production` |

### Docker CLI

```bash
docker run -d \
  --name salesforce-to-tigerpaw \
  -p 5023:5023 \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  -e FLASK_ENV=production \
  --restart unless-stopped \
  ghcr.io/btoth525/salesforce-to-tigerpaw-converter:latest
```

### Docker Compose

```bash
# .env
SECRET_KEY=<paste long random string>
```

```bash
docker compose up -d
```

Open `http://<host>:5023`. Container health is reported via `/api/health`.

> **Note:** If you get `unauthorized` when pulling, the GHCR package is set
> to Private. Either make it Public (Package settings → Change visibility),
> or `docker login ghcr.io` with a PAT scoped `read:packages`.

---

## Development

### Prerequisites

- Python 3.12+
- Node 20+

### Run backend + frontend locally

```bash
# backend — http://localhost:5023
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python SalesforceToTigerpaw.py

# frontend (separate shell) — http://localhost:5173
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api/*` to Flask, so you hit the React UI at
`http://localhost:5173` and it talks to the live backend transparently.

### Tests + lint

```bash
python -m unittest                  # 14 tests, ~0.1s
cd frontend && npm run lint         # eslint
cd frontend && npm run build        # production bundle
```

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/convert` | Upload a Salesforce CSV, download the converted Tigerpaw CSV. |
| `POST` | `/api/preview` | Upload a Salesforce CSV, get JSON with original + converted preview rows, column mapping, row count. |
| `GET` | `/api/health` | Returns `{"status":"ok"}`. Used by the container HEALTHCHECK. |
| `GET` | `/` and `/<path>` | Serves the React SPA. |

All endpoints accept `multipart/form-data` with a `file` field and return
`400` JSON with an `error` key on bad input.

---

## Column transformation

### Source → Destination

| Salesforce column | Tigerpaw column |
| --- | --- |
| `Product Code` | `Part Number` |
| `Description` | `Description` |
| `Quantity` | `Quantity` |
| `Net Unit Price` | `Price` |
| `Unit Cost` | `Cost` |

### Also

- `Total Price` — values dropped, column re-added empty (Tigerpaw recomputes).
- **Added (empty):** `Type`, `List Price`, `Vendor`, `Vendor Part number`,
  `Project Phase`, `Installation Location`, `UOM`.
- **Any other columns** in the source file are preserved and appended after
  the Tigerpaw columns.
- Output is UTF-8 with BOM and CRLF line endings (Excel/Tigerpaw friendly).

Required columns are enforced; if any of the five source columns are
missing, `/api/convert` and `/api/preview` return `400` with the list of
missing column names.

---

## Configuration

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `SECRET_KEY` | yes in prod | random per-process in dev | Flask signing key. Startup **fails** if `FLASK_ENV=production` and this is unset. |
| `FLASK_ENV` | no | unset | Set to `production` for the prod check. |
| `PORT` | no | `5023` | Gunicorn bind port inside the container. |

Upload cap: 10 MB (returns `413 File too large`).

---

## Repository layout

```
Salesforce-to-Tigerpaw-Converter/
├── SalesforceToTigerpaw.py       # Flask app + CSV transform pipeline
├── requirements.txt              # Python deps
├── tests/test_app.py             # unittest suite (transform + routes)
├── Dockerfile                    # multi-stage: Node build → Python runtime
├── docker-compose.yml            # GHCR-based one-command deploy
├── .github/workflows/
│   └── docker-publish.yml        # buildx → ghcr.io on push/tag
└── frontend/                     # Vite + React SPA
    ├── src/App.jsx               # main UI (dropzone → preview → success)
    ├── src/App.css               # theme + aurora + tables
    └── vite.config.js            # dev proxy /api → Flask
```

---

## Release

`main` + semver tags drive the published image tags:

- Every push to `main` → `:latest` + `:sha-<short>`
- Tag `v1.2.3` → `:1.2.3`, `:1.2`, `:latest`
- Branch pushes (including `claude/**`) → `:<branch-name>` (for testing)

To cut a release:

```bash
git tag v1.1.0 && git push --tags
```

---

## Troubleshooting

- **Tigerpaw import complains about columns** — Confirm the Salesforce
  export contains `Product Code`, `Description`, `Quantity`, `Net Unit Price`,
  `Unit Cost`. The preview panel lists exactly what's mapped.
- **`413 File too large`** — Upload is over 10 MB. Split the export or raise
  `MAX_UPLOAD_BYTES` in `SalesforceToTigerpaw.py`.
- **Container reports unhealthy** — `docker logs salesforce-to-tigerpaw`;
  the HEALTHCHECK hits `/api/health` on the internal port.
- **GHCR pull fails with `denied`** — The package is still Private. Open
  Package settings → Change visibility → Public (or login with a PAT).
- **Browser says "Frontend not built."** — You ran Flask against a repo
  where `frontend/dist` is missing. Use the Docker image for production or
  `npm run build` in `frontend/` first.

---

## Contributing

Pull requests welcome. For non-trivial changes, open an issue first.
Please keep `python -m unittest` green and run `npm run lint` in
`frontend/` before submitting.

---

## License

MIT — see [LICENSE](LICENSE).

## Contact

Brandon Toth — ASAP Security Services — <Btoth@serviceasap.com>
