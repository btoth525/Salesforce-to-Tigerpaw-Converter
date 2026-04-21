# Changelog

All notable changes to this project will be documented in this file.

## [1.5.0] - 2026-04-21
### Added
- **Feedback / issues inbox**: floating FAB button on every page opens a modal with a 💡 Suggestion / 🐛 Issue toggle, textarea (2 000 char max), and submit flow. Admins get a new filterable card on `/admin` with open-count badge and one-click **Mark resolved / Reopen / Delete**. Also reachable from the command palette.
- **Location flag badges**: admin event feed now shows a gradient pill with the country flag emoji (derived from ISO country code), a map-pin SVG, and "City, Region, Country" when `ENABLE_GEOIP=1` resolves the IP. ISP shows on hover.
### Changed
- `resolve_geo` now fetches + caches `countryCode` from ip-api.com. `ip_geo` table migrates idempotently via `ALTER TABLE ADD COLUMN`.
- New `feedback` table with indexed `status` and `created_at` columns.
### Endpoints
- `POST /api/feedback`
- `GET /admin/api/feedback`
- `POST /admin/api/feedback/<id>/resolve`
- `POST /admin/api/feedback/<id>/reopen`
- `DELETE /admin/api/feedback/<id>`
### Tests
- 4 new integration tests covering feedback auth, validation, and the full resolve/reopen/delete cycle. 38/38 pass.

## [1.4.0] - 2026-04-21
### Added
- **Team wall on the main page** — 280-char shoutbox visible to anyone using the app. Auto-refreshes; any identified user can post. `GET/POST /api/notes`.
- **Hero stats above the drop zone** — animated count-up of total jobs flipped, today's count, "active now" pulsing pill, and a top-5 weekly leaderboard. Fed by the new public `GET /api/public-stats` endpoint (no IPs or PII).
- **CSV export** of every event from the admin panel via `GET /admin/api/export`. Includes user name, event type, details, IP, device/OS/browser, and timestamp. BOM + CRLF for Excel.
- **Per-user delete** in the admin user table — one click (with confirm) wipes a single user and all their events + notes. `POST /admin/api/user/<id>/delete`.
- **Optional IP geolocation** behind `ENABLE_GEOIP=1`. Resolves public IPs to city/region/country via ip-api.com (free, no key, 45 req/min). Results cached 30 days in SQLite; private IPs skipped. Off by default.
### Changed
- **Name is required** — the first-visit modal no longer has a "Skip (use Guest)" button. Backend `/api/identify` rejects empty names and the literal `Guest`. Existing "Guest" rows from prior versions still render but new ones can't be created.
- Admin nav gets an "Export CSV" button alongside Reset data / Log out.

## [1.3.0] - 2026-04-21
### Added
- **Admin panel at `/admin`** (password-gated via `ADMIN_PASSWORD`) with stat cards, 24-hour activity chart, live auto-refreshing event feed, device/OS/browser breakdowns, user table with active-now indicator, per-user drill-down modal, and a "Reset data" button.
- **User identification**: first-visit modal captures the user's name (skippable → "Guest"), stored in `localStorage` and sent as `X-User-Name` on every API request. Top-bar chip shows the current user and opens the rename modal.
- **Event logging** to SQLite at `/app/data/forge.db`: preview / convert / convert_edited / convert_batch / identify are recorded with user name, IP, User-Agent, and timestamped details (filename, row counts).
- **User-agent parsing** (no external deps): Browser / OS / Device classification for each event.
- Admin JSON endpoints: `GET /admin/api/{stats, users, user/<id>, events}`, `POST /admin/api/reset`.
- Docker: `/app/data` volume declared, `ADMIN_PASSWORD` env var with fail-fast in production, `FORGE_DATA_DIR` override, `templates/` copied into the runtime image.
### Changed
- `docker-compose.yml` now mounts `./data:/app/data` and requires `ADMIN_PASSWORD` at boot.
- 8 new integration tests covering identify, admin auth, stats/events/users, user detail, and reset. 28/28 pass.

## [1.2.0] - 2026-04-21
### Added
- **Command palette** (`⌘K` / `Ctrl+K`): searchable, contextual overlay listing every action for the current stage (download, revert edits, toggle theme, switch tabs, clear filter, remove file, etc.). Arrow keys navigate, Enter runs, Esc closes.
- **Global drag-drop veil**: drag a file anywhere over the window and the entire app becomes a drop target with a pulsing ring.
- **Toast notifications**: success / warning / error / info toasts in the bottom-right, replacing the inline error banner. Auto-dismiss after ~4s or click to dismiss.
- **Micro-animations**: stat cards count up from 0 on preview load; skeleton shimmer during `/api/preview` instead of a bare spinner.
- **Bulk convert** via `POST /api/convert-batch`: N CSVs → ZIP. Failed files listed in `_errors.txt` inside the archive.
- **Inline cell editing** in the Converted preview tab, with a dual-button action bar (`Download as-is` / `Download edited`) and a pulsing amber "dirty dot" on the file chip.
- Preview row cap raised 25 → 500 plus a `truncated` flag on the response.
- Screenshots for the README under `docs/screenshots/`.
### Changed
- Replaced `Loading` spinner with a layout-matching skeleton loader.
- Top bar now includes a "Quick actions ⌘K" chip that opens the command palette.
- Help overlay mentions the new paste/multi-file/edit tips.

## [1.1.0] - 2026-04-21
### Added
- `/api/preview` endpoint returning a JSON preview of original + transformed rows, column mapping, added/dropped columns, and row count.
- `/api/health` endpoint.
- Frontend preview UX: drag-and-drop zone, stats bar, column-mapping card (renamed/kept/added/dropped), tabbed original-vs-converted table with row search, success animation, dark/light theme toggle, keyboard shortcuts (⌘/Ctrl+Enter to convert, Esc to reset).
- Unit + integration tests covering the transform and all routes.
- `.gitignore` to keep uploads, build artifacts, and local env files out of version control.
### Changed
- API routes moved to `/api/convert` and `/api/preview` — the root path now always serves the SPA, resolving the root-route collision.
- Upload size capped at 10 MB (`MAX_CONTENT_LENGTH`) and encoding detection no longer loads the whole file into memory.
- `SECRET_KEY` now fails fast in production instead of silently using a known default; dev generates a per-process random key.
- Errors distinguish 400 (bad input) from 500 (unexpected); tracebacks are preserved via `raise … from e`.
- Dockerfile builds the frontend in a separate stage, runs Gunicorn as a non-root user, and ships with a `/api/health` HEALTHCHECK.
- GitHub Actions workflow (`.github/workflows/docker-publish.yml`) publishes `linux/amd64` images to `ghcr.io/btoth525/salesforce-to-tigerpaw-converter` on every push and tag.
- `docker-compose.yml` now references the published GHCR image by default.
- Vite dev server proxies `/api` to Flask for a smooth local dev loop.
### Removed
- Stale PyInstaller artifacts (`build/`, `dist/`, `*.spec`), legacy `templates/` + `static/` directories, empty root `package-lock.json`, and committed customer CSVs under `uploads/`. `.gitignore` expanded to block re-adds.

## [1.0.2] - 2025-08-13
### Added
- Animated confetti celebration when conversion completes and as a favicon Easter egg
- Modern, beautiful React frontend with glassmorphism, gradients, and responsive design
- Large animated favicon and custom branding
- Contact button for Brandon Toth
- Animated background gradients
- Footer with version, last updated, and documentation link
- Link to ScribeHow documentation
### Changed
- Improved UI/UX polish, accessibility, and mobile responsiveness
- Reverted to clean, simple interface (no mascot/party mode)

