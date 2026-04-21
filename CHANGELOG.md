# Changelog

All notable changes to this project will be documented in this file.

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
- GitHub Actions workflow (`.github/workflows/docker-publish.yml`) publishes multi-arch (`linux/amd64` + `linux/arm64`) images to `ghcr.io/btoth525/salesforce-to-tigerpaw-converter` on every push and tag.
- `docker-compose.yml` now references the published GHCR image by default.
- Vite dev server proxies `/api` to Flask for a smooth local dev loop.

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

