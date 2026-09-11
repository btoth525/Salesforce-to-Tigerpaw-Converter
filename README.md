# Salesforce → Tigerpaw CSV Converter

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![Publish Docker image to GHCR](https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter/actions/workflows/docker-publish.yml)

A production-ready Flask + React web app that turns Salesforce CSV exports into Tigerpaw-ready imports. Drop a file (or ten), preview the transform, see exactly what was cleaned up and why, optionally edit cells inline, and download. Ships as a single Docker image for Unraid / Docker / Compose.

**v2.0 rebuilt the conversion engine.** Nothing is guessed any more: encoding is detected deterministically, every cell stays a string (no `1.00` → `1.0`, no `00123` → `123`, no `NA` → blank), smart punctuation and stray line breaks are normalised to plain ASCII, Salesforce footer/total rows are dropped, and every change is listed in a Cleanup report before you download.

![Hero](docs/screenshots/01-hero-idle-dark.png)

- 📖 [Step-by-step Scribe guide](https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ)
- 📝 [CHANGELOG](CHANGELOG.md)

---

## Highlights

- **Preview before you commit** — side-by-side original ↔ converted tables with row search and hover-tooltips explaining every column change.
- **Ready-for-Tigerpaw verdict** — one green or amber line telling you whether the file is safe to import, with the download button right there.
- **Cleanup report** — encoding badge, every changed cell (before → after, reason), every dropped row, and warnings such as non-numeric quantities. Fixed cells are highlighted in the table; hover shows the original value.
- **Output options** — plain-ASCII text, UTF-8 BOM, quote-all, keep extra columns, map quote-line Group → Project Phase. Persisted per browser.
- **Drag one file or drop ten** — single files go to the preview stage; 2+ files auto-route to a batch view that streams back a ZIP.
- **Edit inline** — click any converted cell to edit before download. Optional; the no-edit path stays one click.
- **Command palette (⌘K)** — searchable menu of every action, contextual to the current stage.
- **Global drop-anywhere** — drag a file over the window and the entire app becomes a drop target.
- **Toasts, skeleton loader, count-up stats** — the small polish that makes it feel like a $50/month product.
- **Dark / light themes** with persistence, plus a keyboard help overlay (`?`).
- **Public stats on the idle page** — animated "🔥 jobs flipped" counter, "active now" pulsing pill, top-5 weekly 🥇🥈🥉 leaderboard.
- **Team wall** — 280-char shoutbox where the team celebrates wins or drops a tip.
- **Feedback & issues inbox** — floating FAB on every page, admins see submissions in a filterable card on `/admin` with one-click resolve.
- **Admin panel at `/admin`** — password-gated dashboard with live event feed, device breakdown, country flag + city on each event (with GeoIP on), per-user drill-down, CSV export, per-user delete, and reset.
- **Safe by default** — 10 MB upload cap, deterministic encoding detection (BOM → UTF-8 → Windows-1252), fail-fast `SECRET_KEY` + `ADMIN_PASSWORD` in production, directory-traversal protection, non-root container, `/api/health` HEALTHCHECK.

---

## Tour

### Preview the transform

![Preview dark](docs/screenshots/02-preview-dark.png)

A stat bar (with animated count-ups), the four-bucket **Transformation** card (Renamed / Kept / Added / Dropped), and the tabbed original↔converted table. Column headers in the converted tab reveal contextual tooltips on hover (*"Renamed from: Product Code"*, *"Added empty · Tigerpaw column"*, *"Kept from source"*, *"Preserved extra column"*). Renamed columns are purple; added columns are green with a `+` suffix.

### Inline editing

![Dirty edit](docs/screenshots/05-dirty-edit.png)

Click any converted cell → it becomes an input. Enter commits, Esc cancels. Edit anything and the file chip sprouts an amber pulsing dot, a "Revert edits" button appears, and the primary action splits into **Download as-is** / **Download edited** so you can choose. Don't edit anything and the UX is identical to v1.0.

### Command palette

![Command palette](docs/screenshots/03-command-palette.png)

`⌘K` / `Ctrl+K` anywhere. Every action is reachable without a mouse: download, revert edits, toggle theme, switch tabs, clear the filter, browse for files, remove the current file. The list is contextual — edits, revert, and tab-switching only appear in the preview stage.

![Command palette filtered](docs/screenshots/04-cmd-filtered.png)

Type to filter by title, keyword, or group.

### Batch convert

![Batch stage](docs/screenshots/07-batch.png)

Drop 2-25 CSVs → batch stage. Single pulsing **Convert All → Download ZIP** button. Files that fail validation are listed inside `_errors.txt` in the zip, so partial success still yields useful output. Individual `✕` per file re-routes back to single-file preview if you cull down to one.

### Drop-anywhere

![Drag veil](docs/screenshots/10-drag-veil.png)

Drag a file over any part of the page and the whole window becomes a drop target with a pulsing ring. No need to aim at the small dropzone.

### Success toasts

![Toast success](docs/screenshots/06-toast-success.png)

Every action (download, revert, batch complete) surfaces a corner toast with the actual filename. Errors show red; warnings (e.g. "File has 2,300 rows — editing disabled") show amber. Auto-dismisses after ~4s or click the `✕`.

### Light mode

![Preview light](docs/screenshots/08-preview-light.png)

Every element has light-theme styling. Theme preference is persisted to `localStorage`.

### Help overlay

![Help overlay](docs/screenshots/09-help-overlay.png)

Press `?` anywhere for the shortcut cheatsheet.

### Name prompt + user chip

![Name required modal](docs/screenshots/16-name-required.png)

First-visit modal asks for a name — **required, no skip**. The name is stored in
`localStorage` and sent as `X-User-Name` on every API request so the admin
panel can attribute activity. Shows as a chip in the top bar; click to change.

### Team wall + live stats on the main page

![Hero stats + team wall](docs/screenshots/17-idle-with-wall.png)

The idle page leads with a live **🔥 jobs flipped** counter (animated count-up),
today's count, a green pulsing "active now" pill, and the top-5 leaderboard for
the current week.

Below the drop zone, the **Team Wall** is a 280-char shoutbox where anyone who's
identified can post a quick note — celebrate a win, share a tip, drop a vibe.
Auto-refreshes every 30s.

### Feedback — suggestions & issues

![Feedback modal](docs/screenshots/19-feedback-modal.png)

A floating **Feedback** button sits in the bottom-right of every page. Click
it (or `⌘K → "Send feedback"`) to file a 💡 **Suggestion** or a 🐛 **Issue**
— up to 2,000 characters, with a live counter. Submissions land in the admin
dashboard instantly.

![Admin feedback inbox](docs/screenshots/20-admin-feedback.png)

Admins get a dedicated **Feedback** card with an open-count badge, filter
chips (Open / Resolved / All), color-coded pills per kind, and per-row
**Mark resolved / Reopen / Delete** actions.

---

## Admin panel

`/admin` is password-gated via the `ADMIN_PASSWORD` env var. Telemetry
persists in a SQLite file at `/app/data/forge.db` (mount a volume in
production).

![Admin dashboard](docs/screenshots/14-admin-dashboard.png)

- **Stat cards** — total users, active now (pulsing dot if anyone's used
  the app in the last 5 minutes), events today, total events.
- **Activity chart** — one bar per hour for the last 24 hours, "now" on
  the right.
- **Live event feed** — auto-refreshes every 5 seconds, color-coded pills
  per event type (`identify`, `preview`, `convert`, `convert_edited`,
  `convert_batch`, `feedback_submitted`, `note_posted`), filename + row
  count + device + IP + relative time. With `ENABLE_GEOIP=1`, public IPs
  resolve to a gradient pill showing the **country flag emoji + map pin +
  "City, Region, Country"** (ISP on hover).
- **Device / OS / browser breakdowns** — the last 7 days, with percent bars.
- **Feedback inbox** — filterable card with open-count badge; one-click
  resolve / reopen / delete.
- **User table** — active-now green dot, event count, last seen, first
  seen, device fingerprint, last IP. Click any row for the drill-down.

![Admin user detail](docs/screenshots/15-admin-user-detail.png)

Click a user to see their last 50 events in detail.

**Actions:**
- **Reset data** (top right) — wipes every user + event. Confirm prompt first.
- **Log out** — clears the admin session cookie.

### Admin login

![Admin login](docs/screenshots/13-admin-login.png)

### Admin API

All admin JSON endpoints require the session cookie set by `/admin/login`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/admin` | Dashboard HTML |
| `GET/POST` | `/admin/login` | Password form + submit |
| `POST` | `/admin/logout` | Clear session |
| `GET`  | `/admin/api/stats` | Summary + hourly activity + device/OS/browser breakdowns |
| `GET`  | `/admin/api/users` | All users, newest `last_seen` first |
| `GET`  | `/admin/api/user/<id>` | Single user + last 50 events |
| `POST` | `/admin/api/user/<id>/delete` | Delete one user and all their events + notes |
| `GET`  | `/admin/api/events?limit=N` | Recent events (newest first, max 500). Includes geo on each event when GeoIP is on. |
| `GET`  | `/admin/api/export` | Download every event as a CSV (for Excel / audit) |
| `GET`  | `/admin/api/feedback?status=open\|resolved\|all` | List feedback items + open count |
| `POST` | `/admin/api/feedback/<id>/resolve` | Mark a feedback item resolved |
| `POST` | `/admin/api/feedback/<id>/reopen` | Reopen a resolved item |
| `DELETE` | `/admin/api/feedback/<id>` | Delete a feedback item permanently |
| `POST` | `/admin/api/reset` | Wipe all telemetry |

### Privacy

- Data is stored locally in SQLite; nothing leaves the container.
- No geolocation by default (IP is logged but not resolved to a location).
  IPs behind `X-Forwarded-For` (Unraid's reverse proxy, etc.) are captured
  as the first hop — set `FLASK_TRUSTED_HOSTS` if you need stricter.
- `localStorage` holds the user's name only on their browser.
- `docker exec -it salesforce-to-tigerpaw sqlite3 /app/data/forge.db` gets
  you a direct prompt if you need to query or delete specific rows.

---

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `⌘/Ctrl + K` | Open command palette |
| `⌘/Ctrl + V` | Paste a CSV (file or raw text) |
| `⌘/Ctrl + ↵` | Convert & download (preview or batch) |
| `Esc` | Close overlay / reset / go back |
| `?` | Show keyboard shortcuts |

---

## Deploy

Prebuilt image on GHCR:
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
| **Path** — data | Host `/mnt/user/appdata/salesforce-to-tigerpaw/` → Container `/app/data` |
| **Variable** — `SECRET_KEY` | *any long random string*, e.g. `openssl rand -hex 32` |
| **Variable** — `ADMIN_PASSWORD` | password for the `/admin` dashboard |
| **Variable** — `FLASK_ENV` | `production` |

### Docker CLI

```bash
docker run -d \
  --name salesforce-to-tigerpaw \
  -p 5023:5023 \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  -e ADMIN_PASSWORD="your-admin-password" \
  -e FLASK_ENV=production \
  -v /mnt/user/appdata/salesforce-to-tigerpaw:/app/data \
  --restart unless-stopped \
  ghcr.io/btoth525/salesforce-to-tigerpaw-converter:latest
```

### Docker Compose

```bash
# .env
SECRET_KEY=<paste long random string>

docker compose up -d
```

Container health is reported via `/api/health`.

> If `docker pull` returns `denied`, the GHCR package is set to Private.
> Open Package settings → Change visibility → Public, or `docker login
> ghcr.io` with a PAT scoped `read:packages`.

---

## Development

**Prerequisites:** Python 3.12+, Node 20+.

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
python -m unittest                  # 104 tests, ~0.4s
cd frontend && npm run lint         # eslint
cd frontend && npm run build        # production bundle
```

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/convert` | Single CSV → converted Tigerpaw CSV. `X-Convert-Summary` header carries `{rows, skipped, changes, warnings, encoding}`. Accepts the output options as form fields. |
| `POST` | `/api/convert-batch` | N CSVs under `files` → ZIP (`_report.txt` with per-file cleanup counts, `_errors.txt` for any failures). |
| `POST` | `/api/convert-edited` | JSON `{ filename, columns, rows, options }` → CSV (for post-preview edits; edited cells get the same cleanup). |
| `POST` | `/api/preview` | Single CSV → JSON preview (first 2 000 rows, mapping, `aliasesUsed`, `encoding`, `skippedRows`, `changes`, `warnings`, `truncated`). |
| `POST` | `/api/identify` | Register / update the current user's name. Rejects empty / "Guest". |
| `GET`  | `/api/public-stats` | Public totals + top-5 weekly leaderboard (safe to display on the idle page). |
| `GET`/`POST` | `/api/notes` | Team wall — read recent notes, post a new one (280 char max). |
| `POST` | `/api/feedback` | Submit a suggestion or issue (requires a real `X-User-Name`, 2 000 char max). |
| `GET`  | `/api/health` | `{"status":"ok","version":"2.1.0"}` — used by the container HEALTHCHECK. |
| `GET`  | `/` and `/<path>` | Serves the React SPA. |

All endpoints accept `multipart/form-data` or JSON and return `400` JSON with an `error` key on bad input. Max upload: 10 MB; max files per batch: 25.

---

## Column transformation

### Source → Destination

| Salesforce column (aliases accepted) | Tigerpaw column |
| --- | --- |
| `Product Code` (`Product: Product Code`, `Part Number`, `SKU`, `Item Code`) | `Part Number` |
| `Description` (`Product Description`, `Line Description`) | `Description` |
| `Quantity` (`Qty`) | `Quantity` |
| `Net Unit Price` (`Unit Price`, `Sales Price`, `Net Price`, `Price`) | `Price` |
| `Unit Cost` (`Cost`, `Product Cost`) | `Cost` |
| `Group: Group Name` (optional, off by default) | `Project Phase` |

Header matching is case- and whitespace-insensitive and exact (no fuzzy substring
matches, so `Cost: Cost #` is never mistaken for a cost). Title lines above the
header are skipped. The delimiter (`,` `;` tab `|`) is detected from the header.

- `Total Price` — values dropped, column re-added empty so Tigerpaw can recompute.
- **Added (empty):** `Type`, `List Price`, `Vendor`, `Vendor Part number`, `Project Phase`, `Installation Location`, `UOM`.
- Any other source columns are preserved and appended at the end (toggle: *Keep extra Salesforce columns*).

### What the engine cleans (and reports)

Every cell is treated as text — nothing is parsed into numbers or dates, so
leading zeros, `1.00`, `3E4` and a literal `NA` all survive. The following
cleanups are applied and each one is listed in the preview's Cleanup card:

| Kind | What happens |
| --- | --- |
| Mojibake repaired | Text that was already double-encoded by another tool (`â€™`, `Ã©`) is restored. |
| Smart punctuation | `’ “ ” – — … × ™ ® ° ½` → `' " " - - ... x (TM) (R) deg 1/2`; accented letters → plain (`é` → `e`). |
| Line break removed | Newlines inside a description become a single space (one product = one row). |
| Control chars removed | Stray control bytes are deleted. |
| Whitespace trimmed | Runs of spaces collapsed, ends trimmed. |
| Number cleaned | Quantity / Price / Cost only: `$1,299.00` → `1299.00`, `USD 5.00` → `5.00`, `(12.50)` → `-12.50`. Decimals untouched. |

Rows are dropped (and listed) when they are blank, a Salesforce footer line
(`Copyright…`, `Confidential Information…`, `Generated By…`), a `Grand Totals`
row, or a title line above the header.

Warnings (never fatal): non-numeric quantity/price/cost, empty part number,
empty description, ragged rows, duplicate headers, undecodable bytes replaced.

### Output

UTF-8 with BOM and CRLF line endings by default (Excel/Tigerpaw friendly, same
as v1). With *Plain ASCII text* on (default) the content is pure ASCII, so it
reads identically whether the importer assumes UTF-8 or Windows ANSI.

| Option | Default | Effect |
| --- | --- | --- |
| Plain ASCII text | on | Transliterate anything non-ASCII; guarantees no garbled characters downstream. |
| UTF-8 BOM | on | Prepend the byte-order mark Excel expects. Off = bare UTF-8 (pure ASCII when the option above is on). |
| Quote every field | off | `QUOTE_ALL` instead of quoting only when needed. |
| Keep extra Salesforce columns | on | Append unmapped source columns after the Tigerpaw ones. |
| Group → Project Phase | off | Fill `Project Phase` from the quote-line group name. |

Required columns are enforced; if any of the five source columns are missing,
the converter returns `400` with the list of missing column names.

---

## Configuration

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `SECRET_KEY` | yes in prod | random per-process in dev | Startup **fails** if `FLASK_ENV=production` and this is unset. |
| `ADMIN_PASSWORD` | yes in prod | `admin` in dev | Password for `/admin`. Startup fails in production if unset. |
| `FLASK_ENV` | no | unset | Set to `production` for the prod check. |
| `PORT` | no | `5023` | Gunicorn bind port inside the container. |
| `FORGE_DATA_DIR` | no | `/app/data` (container) or `./data` (dev) | Where `forge.db` (SQLite telemetry) lives. Mount a volume here in production. |
| `ENABLE_GEOIP` | no | `0` | Set to `1` to resolve IP → city/region/country via ip-api.com (free tier) and show it in the admin event feed. Results cached 30 days in SQLite; IPs from private ranges are skipped. Third-party dependency — read the privacy note before enabling. |

---

## Repository layout

```
Salesforce-to-Tigerpaw-Converter/
├── SalesforceToTigerpaw.py       # Flask app: routes, admin, telemetry
├── converter.py                  # Pure-stdlib CSV engine (decode, detect header, clean, build)
├── requirements.txt              # Python deps
├── tests/test_converter.py       # engine tests (encodings, aliases, footer, numbers, mojibake)
├── tests/test_app.py             # route tests
├── Dockerfile                    # multi-stage: Node build → Python runtime
├── docker-compose.yml            # GHCR-based one-command deploy
├── docs/screenshots/             # README imagery
├── .github/workflows/
│   └── docker-publish.yml        # buildx → ghcr.io on push / tag
└── frontend/                     # Vite + React SPA
    ├── src/App.jsx               # main UI
    ├── src/App.css               # theme + aurora + tables + overlays
    └── vite.config.js            # dev proxy /api → Flask
```

---

## Release

`main` + semver tags drive the published image tags:

- Every push to `main` → `:latest` + `:sha-<short>`
- Tag `v1.2.3` → `:1.2.3`, `:1.2`, `:latest`
- Branch pushes (including `claude/**`) → `:<branch-name>` (for testing)

Cut a release:
```bash
git tag v1.2.0 && git push --tags
```

---

## Troubleshooting

- **Tigerpaw import complains about columns** — Confirm the Salesforce export contains `Product Code`, `Description`, `Quantity`, `Net Unit Price`, `Unit Cost` (or an accepted alias). The preview panel's Transformation card lists exactly what got mapped.
- **Garbled characters in Tigerpaw** — Should no longer happen: with *Plain ASCII text* on, the file contains only ASCII. If a description still looks wrong, open the Cleanup card; the original value is shown next to the fixed one.
- **A row is missing after conversion** — Check *rows dropped* in the Cleanup card. Blank, footer and totals rows are removed deliberately and listed with their content.
- **`413 File too large`** — Upload is over 10 MB. Split the export or raise `MAX_UPLOAD_BYTES` in `SalesforceToTigerpaw.py`.
- **Container reports unhealthy** — `docker logs salesforce-to-tigerpaw`; the HEALTHCHECK hits `/api/health` on the internal port.
- **GHCR pull fails with `denied`** — Package is still Private. Open Package settings → Change visibility → Public (or login with a PAT).
- **"Editing disabled" toast** — File has more rows than the preview cap (2 000). Use Download as-is, or split the file.

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
