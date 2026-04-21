"""Salesforce → Tigerpaw CSV converter.

Flask app exposing JSON APIs under ``/api/*`` and serving the React SPA from
``frontend/dist`` at the root.
"""

from __future__ import annotations

import csv
import io
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from functools import wraps

import chardet
import pandas as pd
from flask import (
    Flask,
    Response,
    abort,
    g,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.utils import secure_filename


# --- Transform rules ---------------------------------------------------------

COLUMN_MAPPING = {
    "Product Code": "Part Number",
    "Description": "Description",
    "Quantity": "Quantity",
    "Net Unit Price": "Price",
    "Unit Cost": "Cost",
}
DROP_COLUMNS = ["Total Price"]
NEW_COLUMNS = [
    "Type",
    "List Price",
    "Vendor",
    "Vendor Part number",
    "Project Phase",
    "Installation Location",
    "Total Price",
    "UOM",
]
DESIRED_ORDER = [
    "Part Number",
    "Description",
    "Quantity",
    "Price",
    "Cost",
    "Total Price",
    "Type",
    "List Price",
    "UOM",
    "Vendor",
    "Vendor Part number",
    "Project Phase",
    "Installation Location",
]

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB (per request)
PREVIEW_ROWS = 500  # enough to cover typical quote exports end-to-end
ENCODING_SNIFF_BYTES = 64 * 1024
BATCH_MAX_FILES = 25

# --- Admin / telemetry -------------------------------------------------------

DATA_DIR = os.environ.get("FORGE_DATA_DIR") or os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DATA_DIR, "forge.db")
ACTIVE_WINDOW_SECONDS = 5 * 60  # user is "active" if seen in the last N seconds
ADMIN_SESSION_KEY = "_admin"
NOTE_MAX_LEN = 280
NOTES_RECENT_LIMIT = 20
ENABLE_GEOIP = os.environ.get("ENABLE_GEOIP", "0") == "1"
GEOIP_TIMEOUT_SECONDS = 2.5
GEOIP_CACHE_TTL_DAYS = 30


# --- App ---------------------------------------------------------------------

REACT_BUILD_DIR = os.path.join(os.path.dirname(__file__), "frontend", "dist")
REACT_ASSETS_DIR = os.path.join(REACT_BUILD_DIR, "assets")
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")
app = Flask(
    __name__,
    static_folder=REACT_ASSETS_DIR,
    static_url_path="/assets",
    template_folder=TEMPLATES_DIR,
)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

_secret = os.environ.get("SECRET_KEY")
if not _secret:
    if os.environ.get("FLASK_ENV") == "production":
        raise RuntimeError("SECRET_KEY env var must be set in production")
    _secret = secrets.token_hex(32)
app.config["SECRET_KEY"] = _secret

_admin_password = os.environ.get("ADMIN_PASSWORD")
if not _admin_password:
    if os.environ.get("FLASK_ENV") == "production":
        raise RuntimeError("ADMIN_PASSWORD env var must be set in production")
    _admin_password = "admin"  # dev default only
app.config["ADMIN_PASSWORD"] = _admin_password
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("SalesforceToTigerpaw")


# --- Database ---------------------------------------------------------------

os.makedirs(DATA_DIR, exist_ok=True)


def _db() -> sqlite3.Connection:
    """Per-request SQLite connection, cached on ``flask.g``."""
    conn = getattr(g, "_db_conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        g._db_conn = conn
    return conn


@app.teardown_appcontext
def _close_db(_exc) -> None:
    conn = getattr(g, "_db_conn", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    """Create tables if they don't exist. Idempotent."""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                last_ip TEXT,
                last_user_agent TEXT,
                event_count INTEGER NOT NULL DEFAULT 0,
                UNIQUE(name)
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                user_name TEXT NOT NULL,
                event_type TEXT NOT NULL,
                details TEXT,
                ip TEXT,
                user_agent TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
            CREATE INDEX IF NOT EXISTS events_user ON events(user_id);

            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                user_name TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS notes_created ON notes(created_at);

            CREATE TABLE IF NOT EXISTS ip_geo (
                ip TEXT PRIMARY KEY,
                country TEXT,
                region TEXT,
                city TEXT,
                isp TEXT,
                cached_at TEXT NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


init_db()


# --- User agent parsing (heuristic, no external deps) ------------------------


def parse_user_agent(ua: str) -> dict:
    """Return ``{browser, os, device}`` from a user-agent string."""
    if not ua:
        return {"browser": "Unknown", "os": "Unknown", "device": "Unknown"}
    ua_l = ua.lower()

    if "edg/" in ua_l: browser = "Edge"
    elif "opr/" in ua_l or "opera" in ua_l: browser = "Opera"
    elif "firefox" in ua_l: browser = "Firefox"
    elif "chrome" in ua_l and "safari" in ua_l: browser = "Chrome"
    elif "safari" in ua_l: browser = "Safari"
    elif "curl" in ua_l: browser = "curl"
    else: browser = "Unknown"

    if "iphone" in ua_l: os_name, device = "iOS", "iPhone"
    elif "ipad" in ua_l: os_name, device = "iPadOS", "iPad"
    elif "android" in ua_l:
        os_name = "Android"
        device = "Tablet" if "tablet" in ua_l else "Phone"
    elif "mac os x" in ua_l: os_name, device = "macOS", "Desktop"
    elif "windows" in ua_l: os_name, device = "Windows", "Desktop"
    elif "linux" in ua_l: os_name, device = "Linux", "Desktop"
    else: os_name, device = "Unknown", "Unknown"

    return {"browser": browser, "os": os_name, "device": device}


def _is_public_ip(ip: str) -> bool:
    if not ip or ip == "unknown":
        return False
    try:
        addr = ipaddress.ip_address(ip)
        return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast)
    except ValueError:
        return False


def resolve_geo(ip: str) -> dict | None:
    """Resolve an IP via ip-api.com (free, no key). Cached in SQLite.

    Respects ENABLE_GEOIP=1. Returns ``None`` for private IPs, disabled,
    network errors, or failed lookups. Cached rows expire after
    ``GEOIP_CACHE_TTL_DAYS`` days.
    """
    if not ENABLE_GEOIP or not _is_public_ip(ip):
        return None
    conn = _db()
    row = conn.execute(
        "SELECT country, region, city, isp, cached_at FROM ip_geo WHERE ip = ?", (ip,)
    ).fetchone()
    now = datetime.now(timezone.utc)
    if row:
        # Honor TTL so we eventually re-resolve stale rows.
        try:
            cached = _parse_iso(row["cached_at"])
            if (now - cached).days < GEOIP_CACHE_TTL_DAYS:
                return {"country": row["country"], "region": row["region"],
                        "city": row["city"], "isp": row["isp"], "cached": True}
        except Exception:
            pass

    try:
        req = urllib.request.Request(
            f"http://ip-api.com/json/{ip}?fields=status,country,regionName,city,isp",
            headers={"User-Agent": "CSV-Forge/1.4"},
        )
        with urllib.request.urlopen(req, timeout=GEOIP_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("status") != "success":
            return None
        result = {
            "country": data.get("country"),
            "region": data.get("regionName"),
            "city": data.get("city"),
            "isp": data.get("isp"),
            "cached": False,
        }
        conn.execute(
            "INSERT OR REPLACE INTO ip_geo (ip, country, region, city, isp, cached_at) VALUES (?, ?, ?, ?, ?, ?)",
            (ip, result["country"], result["region"], result["city"], result["isp"], now.isoformat()),
        )
        conn.commit()
        return result
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        logger.warning("geoip lookup failed for %s: %s", ip, e)
        return None


# --- Client identification + event recording --------------------------------


_NAME_RE = re.compile(r"[^\w .'\-]+")


def _sanitize_name(raw: str | None) -> str:
    if not raw:
        return "Guest"
    cleaned = _NAME_RE.sub("", raw).strip()[:60]
    return cleaned or "Guest"


def _client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For")
    return (fwd.split(",")[0].strip() if fwd else request.remote_addr) or "unknown"


def _current_user_name() -> str:
    return _sanitize_name(request.headers.get("X-User-Name"))


def _upsert_user(name: str, ip: str, ua: str) -> int:
    now = datetime.now(timezone.utc).isoformat()
    conn = _db()
    row = conn.execute("SELECT id FROM users WHERE name = ?", (name,)).fetchone()
    if row:
        conn.execute(
            "UPDATE users SET last_seen=?, last_ip=?, last_user_agent=? WHERE id=?",
            (now, ip, ua, row["id"]),
        )
        conn.commit()
        return row["id"]
    cur = conn.execute(
        "INSERT INTO users (name, first_seen, last_seen, last_ip, last_user_agent) VALUES (?, ?, ?, ?, ?)",
        (name, now, now, ip, ua),
    )
    conn.commit()
    return cur.lastrowid


def record_event(event_type: str, details: dict | None = None) -> None:
    """Log an event attributed to the current X-User-Name (or Guest)."""
    name = _current_user_name()
    ip = _client_ip()
    ua = request.headers.get("User-Agent", "")
    now = datetime.now(timezone.utc).isoformat()
    try:
        conn = _db()
        user_id = _upsert_user(name, ip, ua)
        conn.execute(
            "INSERT INTO events (user_id, user_name, event_type, details, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, name, event_type, json.dumps(details or {}), ip, ua, now),
        )
        conn.execute("UPDATE users SET event_count = event_count + 1 WHERE id = ?", (user_id,))
        conn.commit()
    except Exception:
        # Telemetry failures must never break a user request.
        logger.exception("Failed to record event %s for %s", event_type, name)


# --- Admin auth -------------------------------------------------------------


def admin_required(fn):
    """Gate a view behind the admin session cookie."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get(ADMIN_SESSION_KEY):
            if request.path.startswith("/admin/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("admin_login"))
        return fn(*args, **kwargs)

    return wrapper


@app.before_request
def _log_start() -> None:
    request.environ["_start_time"] = time.perf_counter()


@app.after_request
def _log_end(response: Response) -> Response:
    start = request.environ.get("_start_time")
    ms = f"{(time.perf_counter() - start) * 1000:.1f}ms" if start else "?"
    # Skip noisy polling traffic (Unraid / healthcheck hit /api/health every 30s).
    if request.path != "/api/health":
        logger.info(
            "%s %s -> %s (%s)",
            request.method,
            request.path,
            response.status_code,
            ms,
        )
    return response


def _safe_static_path(req_path: str) -> str | None:
    """Resolve a request path under REACT_BUILD_DIR, refusing anything outside.

    Returns an absolute path on success, ``None`` if the request is either
    empty, tries to traverse out of the build directory, or doesn't resolve
    to an existing file.
    """
    if not req_path:
        return None
    base = os.path.realpath(REACT_BUILD_DIR)
    candidate = os.path.realpath(os.path.join(base, req_path))
    try:
        if os.path.commonpath([base, candidate]) != base:
            return None
    except ValueError:
        # commonpath raises on mixed drive letters / empty; treat as unsafe.
        return None
    return candidate if os.path.isfile(candidate) else None


# --- CSV pipeline ------------------------------------------------------------


def detect_encoding(input_stream) -> str:
    """Sniff encoding from the first chunk without loading the whole file."""
    sample = input_stream.read(ENCODING_SNIFF_BYTES)
    input_stream.seek(0)
    result = chardet.detect(sample)
    return result["encoding"] or "utf-8"


def parse_csv(input_stream, encoding: str):
    """Try common delimiters until one yields a non-empty DataFrame."""
    for delim in (",", ";", "\t"):
        input_stream.seek(0)
        try:
            df = pd.read_csv(
                input_stream,
                encoding=encoding,
                delimiter=delim,
                skip_blank_lines=True,
            )
        except pd.errors.ParserError:
            continue
        if not df.empty:
            return df
    return None


def transform_salesforce_df(df: pd.DataFrame) -> pd.DataFrame:
    """Rename, drop, add, and reorder columns per the Tigerpaw import spec."""
    missing = [col for col in COLUMN_MAPPING if col not in df.columns]
    if missing:
        raise ValueError(f"Missing expected columns in CSV: {', '.join(missing)}")

    df = df.rename(columns=COLUMN_MAPPING)
    df = df.drop(columns=[c for c in DROP_COLUMNS if c in df.columns], errors="ignore")
    for col in NEW_COLUMNS:
        if col not in df.columns:
            df[col] = ""
    ordered = [c for c in DESIRED_ORDER if c in df.columns]
    others = [c for c in df.columns if c not in ordered]
    return df[ordered + others]


def read_salesforce_csv(input_stream) -> pd.DataFrame:
    """Detect encoding + parse, raising ValueError on empty/invalid input."""
    encoding = detect_encoding(input_stream)
    try:
        df = parse_csv(input_stream, encoding)
    except pd.errors.EmptyDataError as e:
        raise ValueError("The uploaded CSV file is empty or could not be parsed.") from e
    if df is None or df.empty:
        raise ValueError("The uploaded CSV file is empty or could not be parsed.")
    return df


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    """Serialize a DataFrame to CSV bytes with BOM + CRLF for Excel/Tigerpaw."""
    buffer = io.StringIO()
    df.to_csv(buffer, index=False, encoding="utf-8-sig", lineterminator="\r\n")
    return buffer.getvalue().encode("utf-8-sig")


def _json_safe_records(df: pd.DataFrame, limit: int) -> list[dict]:
    """Return up to ``limit`` rows as JSON-safe dicts (NaN → None)."""
    head = df.head(limit)
    records = []
    for row in head.to_dict(orient="records"):
        clean = {}
        for k, v in row.items():
            if isinstance(v, float) and math.isnan(v):
                clean[k] = None
            else:
                clean[k] = v
        records.append(clean)
    return records


# --- Request validation ------------------------------------------------------


def _extract_csv_upload():
    """Return the uploaded CSV FileStorage or a (json, status) error tuple."""
    if "file" not in request.files:
        return None, (jsonify({"error": "No file part in the request."}), 400)
    file = request.files["file"]
    if file.filename == "":
        return None, (jsonify({"error": "No file selected."}), 400)
    if not file.filename.lower().endswith(".csv"):
        return None, (jsonify({"error": "Invalid file type. Please upload a CSV file."}), 400)
    return file, None


# --- Routes ------------------------------------------------------------------


@app.route("/api/preview", methods=["POST"])
def preview_route():
    """Return a JSON preview of both the original and transformed data."""
    file, err = _extract_csv_upload()
    if err:
        return err
    try:
        df = read_salesforce_csv(file.stream)
        transformed = transform_salesforce_df(df.copy())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    row_count = int(len(df))
    record_event("preview", {"filename": secure_filename(file.filename), "rows": row_count})
    return jsonify(
        {
            "filename": secure_filename(file.filename),
            "originalColumns": list(df.columns),
            "transformedColumns": list(transformed.columns),
            "rowCount": row_count,
            "previewLimit": PREVIEW_ROWS,
            "truncated": row_count > PREVIEW_ROWS,
            "originalPreview": _json_safe_records(df, PREVIEW_ROWS),
            "transformedPreview": _json_safe_records(transformed, PREVIEW_ROWS),
            "mapping": COLUMN_MAPPING,
            "addedColumns": NEW_COLUMNS,
            "droppedColumns": [c for c in DROP_COLUMNS if c in df.columns],
        }
    )


@app.route("/api/convert", methods=["POST"])
def convert_route():
    """Accept a Salesforce CSV and return the converted Tigerpaw CSV."""
    file, err = _extract_csv_upload()
    if err:
        return err

    filename = secure_filename(file.filename)
    output_filename = os.path.splitext(filename)[0] + "_converted.csv"
    try:
        df = read_salesforce_csv(file.stream)
        transformed = transform_salesforce_df(df)
        payload = dataframe_to_csv_bytes(transformed)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    record_event("convert", {"filename": filename, "rows": int(len(df))})
    return Response(
        payload,
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{output_filename}"',
            "Content-Type": "text/csv; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.route("/api/convert-edited", methods=["POST"])
def convert_edited_route():
    """Accept already-transformed JSON rows (with user edits) and return CSV."""
    body = request.get_json(silent=True) or {}
    filename = secure_filename(body.get("filename") or "converted.csv")
    columns = body.get("columns")
    rows = body.get("rows")
    if not isinstance(columns, list) or not columns:
        return jsonify({"error": "`columns` must be a non-empty list."}), 400
    if not isinstance(rows, list):
        return jsonify({"error": "`rows` must be a list of row objects."}), 400

    # Coerce each row into a dict aligned with the requested column order;
    # fill any missing keys with empty string so the CSV has a stable shape.
    frame = pd.DataFrame(
        [{c: ("" if r.get(c) is None else r.get(c)) for c in columns} for r in rows],
        columns=columns,
    )
    payload = dataframe_to_csv_bytes(frame)
    output_filename = filename if filename.endswith(".csv") else filename + ".csv"

    record_event("convert_edited", {"filename": output_filename, "rows": len(rows)})
    return Response(
        payload,
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{output_filename}"',
            "Content-Type": "text/csv; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    )


@app.route("/api/convert-batch", methods=["POST"])
def convert_batch_route():
    """Accept multiple CSVs under the ``files`` form field and return a ZIP."""
    uploads = request.files.getlist("files")
    if not uploads:
        return jsonify({"error": "No files uploaded."}), 400
    if len(uploads) > BATCH_MAX_FILES:
        return (
            jsonify({"error": f"Too many files. Max {BATCH_MAX_FILES} per batch."}),
            400,
        )

    zip_buffer = io.BytesIO()
    results = []
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in uploads:
            name = secure_filename(f.filename or "upload.csv")
            out_name = os.path.splitext(name)[0] + "_converted.csv"
            if not name.lower().endswith(".csv"):
                results.append({"filename": name, "status": "skipped", "error": "not a .csv"})
                continue
            try:
                df = read_salesforce_csv(f.stream)
                transformed = transform_salesforce_df(df)
                zf.writestr(out_name, dataframe_to_csv_bytes(transformed))
                results.append({"filename": name, "status": "ok", "rows": int(len(df))})
            except ValueError as e:
                results.append({"filename": name, "status": "error", "error": str(e)})

        errors = [r for r in results if r["status"] != "ok"]
        if errors:
            summary = "Files with errors:\n" + "\n".join(
                f"  - {r['filename']}: {r.get('error', 'unknown')}" for r in errors
            )
            zf.writestr("_errors.txt", summary.encode("utf-8"))

    ok_count = sum(1 for r in results if r["status"] == "ok")
    record_event(
        "convert_batch",
        {"files": len(uploads), "ok": ok_count, "failed": len(uploads) - ok_count},
    )
    zip_buffer.seek(0)
    return Response(
        zip_buffer.getvalue(),
        mimetype="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="converted_batch.zip"',
            "X-Batch-Summary": f"{ok_count}/{len(uploads)} succeeded",
        },
    )


@app.route("/api/public-stats")
def public_stats_route():
    """Stats safe for anyone to see — no IPs, no UAs, just counts + names."""
    conn = _db()
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    week_start = (now - timedelta(days=7)).isoformat()
    total_jobs = conn.execute(
        "SELECT COUNT(*) c FROM events WHERE event_type IN ('convert', 'convert_edited', 'convert_batch')"
    ).fetchone()["c"]
    jobs_today = conn.execute(
        "SELECT COUNT(*) c FROM events WHERE event_type IN ('convert', 'convert_edited', 'convert_batch') AND created_at >= ?",
        (today_start,),
    ).fetchone()["c"]
    active_cutoff = now.timestamp() - ACTIVE_WINDOW_SECONDS
    active_users = sum(
        1 for r in conn.execute("SELECT last_seen FROM users").fetchall()
        if _parse_iso(r["last_seen"]).timestamp() >= active_cutoff
    )
    top = conn.execute(
        """
        SELECT user_name AS name, COUNT(*) c
        FROM events
        WHERE event_type IN ('convert', 'convert_edited', 'convert_batch')
          AND created_at >= ?
        GROUP BY user_name
        ORDER BY c DESC
        LIMIT 5
        """,
        (week_start,),
    ).fetchall()
    return jsonify(
        {
            "totalJobs": total_jobs,
            "jobsToday": jobs_today,
            "activeUsers": active_users,
            "topWeek": [{"name": r["name"], "count": r["c"]} for r in top],
        }
    )


@app.route("/api/notes", methods=["GET", "POST"])
def notes_route():
    """Team wall — anyone (identified) can post a short note; anyone can read."""
    conn = _db()
    if request.method == "GET":
        limit = min(int(request.args.get("limit", NOTES_RECENT_LIMIT)), 100)
        rows = conn.execute(
            "SELECT id, user_name, text, created_at FROM notes ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return jsonify(
            {
                "notes": [
                    {"id": r["id"], "user": r["user_name"], "text": r["text"], "createdAt": r["created_at"]}
                    for r in rows
                ]
            }
        )

    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    name = _current_user_name()
    if name == "Guest":
        return jsonify({"error": "Set your name before posting."}), 400
    if not text:
        return jsonify({"error": "Note can't be empty."}), 400
    if len(text) > NOTE_MAX_LEN:
        return jsonify({"error": f"Note too long — max {NOTE_MAX_LEN} characters."}), 400
    ip = _client_ip()
    ua = request.headers.get("User-Agent", "")
    user_id = _upsert_user(name, ip, ua)
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO notes (user_id, user_name, text, created_at) VALUES (?, ?, ?, ?)",
        (user_id, name, text, now),
    )
    conn.commit()
    record_event("note_posted", {"length": len(text)})
    return jsonify({"id": cur.lastrowid, "user": name, "text": text, "createdAt": now})


@app.route("/api/identify", methods=["POST"])
def identify_route():
    """Register / refresh a user by name. Called once per browser on first visit.

    A real name is required — empty / whitespace / "Guest" are rejected so
    admins always see who did what.
    """
    body = request.get_json(silent=True) or {}
    raw = (body.get("name") or "").strip()
    if not raw:
        return jsonify({"error": "Please enter your name."}), 400
    if raw.lower() == "guest":
        return jsonify({"error": "Pick a real name — 'Guest' isn't allowed."}), 400
    name = _sanitize_name(raw)
    if not name or name.lower() == "guest":
        return jsonify({"error": "Please enter your name."}), 400
    ip = _client_ip()
    ua = request.headers.get("User-Agent", "")
    user_id = _upsert_user(name, ip, ua)
    record_event("identify", {"first_time": body.get("firstTime", False)})
    return jsonify({"ok": True, "name": name, "userId": user_id})


# --- Admin routes ----------------------------------------------------------


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "GET":
        if session.get(ADMIN_SESSION_KEY):
            return redirect(url_for("admin_dashboard"))
        return render_template("admin_login.html", error=None)
    submitted = request.form.get("password", "")
    if secrets.compare_digest(submitted, app.config["ADMIN_PASSWORD"]):
        session.permanent = True
        session[ADMIN_SESSION_KEY] = True
        logger.info("admin login from %s", _client_ip())
        return redirect(url_for("admin_dashboard"))
    logger.warning("failed admin login from %s", _client_ip())
    return render_template("admin_login.html", error="Incorrect password."), 401


@app.route("/admin/logout", methods=["POST"])
def admin_logout():
    session.pop(ADMIN_SESSION_KEY, None)
    return redirect(url_for("admin_login"))


@app.route("/admin")
@admin_required
def admin_dashboard():
    return render_template("admin.html")


@app.route("/admin/api/stats")
@admin_required
def admin_stats():
    conn = _db()
    now = datetime.now(timezone.utc)
    active_cutoff = now.timestamp() - ACTIVE_WINDOW_SECONDS
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    total_users = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    total_events = conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"]
    events_today = conn.execute(
        "SELECT COUNT(*) c FROM events WHERE created_at >= ?", (today_start,)
    ).fetchone()["c"]

    users = conn.execute("SELECT last_seen FROM users").fetchall()
    active_users = sum(
        1 for u in users
        if _parse_iso(u["last_seen"]).timestamp() >= active_cutoff
    )

    # Event-type breakdown.
    types = conn.execute(
        "SELECT event_type, COUNT(*) c FROM events GROUP BY event_type ORDER BY c DESC"
    ).fetchall()

    # Hourly activity over the last 24h.
    hours = [{"hour": h, "count": 0} for h in range(24)]
    rows = conn.execute(
        """
        SELECT created_at FROM events
        WHERE created_at >= datetime('now', '-24 hours')
        """
    ).fetchall()
    for r in rows:
        dt = _parse_iso(r["created_at"])
        # Bucket by "how many hours ago", so 0 is the current hour.
        delta_hours = int((now - dt).total_seconds() // 3600)
        if 0 <= delta_hours < 24:
            hours[23 - delta_hours]["count"] += 1

    # Device breakdown from parsed user-agent on recent events.
    ua_rows = conn.execute(
        "SELECT user_agent FROM events WHERE created_at >= datetime('now', '-7 days')"
    ).fetchall()
    browsers, oses, devices = {}, {}, {}
    for r in ua_rows:
        info = parse_user_agent(r["user_agent"] or "")
        browsers[info["browser"]] = browsers.get(info["browser"], 0) + 1
        oses[info["os"]] = oses.get(info["os"], 0) + 1
        devices[info["device"]] = devices.get(info["device"], 0) + 1

    return jsonify(
        {
            "totalUsers": total_users,
            "activeUsers": active_users,
            "totalEvents": total_events,
            "eventsToday": events_today,
            "activeWindowSeconds": ACTIVE_WINDOW_SECONDS,
            "eventTypes": [{"type": r["event_type"], "count": r["c"]} for r in types],
            "hourly": hours,
            "browsers": [{"name": k, "count": v} for k, v in sorted(browsers.items(), key=lambda x: -x[1])],
            "oses": [{"name": k, "count": v} for k, v in sorted(oses.items(), key=lambda x: -x[1])],
            "devices": [{"name": k, "count": v} for k, v in sorted(devices.items(), key=lambda x: -x[1])],
        }
    )


@app.route("/admin/api/users")
@admin_required
def admin_users():
    conn = _db()
    now_ts = datetime.now(timezone.utc).timestamp()
    rows = conn.execute(
        """
        SELECT id, name, first_seen, last_seen, last_ip, last_user_agent, event_count
        FROM users
        ORDER BY last_seen DESC
        """
    ).fetchall()
    out = []
    for r in rows:
        ua = parse_user_agent(r["last_user_agent"] or "")
        is_active = _parse_iso(r["last_seen"]).timestamp() >= now_ts - ACTIVE_WINDOW_SECONDS
        out.append(
            {
                "id": r["id"],
                "name": r["name"],
                "firstSeen": r["first_seen"],
                "lastSeen": r["last_seen"],
                "lastIp": r["last_ip"],
                "eventCount": r["event_count"],
                "active": is_active,
                "browser": ua["browser"],
                "os": ua["os"],
                "device": ua["device"],
            }
        )
    return jsonify({"users": out})


@app.route("/admin/api/user/<int:user_id>")
@admin_required
def admin_user_detail(user_id: int):
    conn = _db()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        return jsonify({"error": "Not found"}), 404
    events = conn.execute(
        """
        SELECT event_type, details, ip, created_at
        FROM events
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
        """,
        (user_id,),
    ).fetchall()
    return jsonify(
        {
            "user": {
                "id": user["id"],
                "name": user["name"],
                "firstSeen": user["first_seen"],
                "lastSeen": user["last_seen"],
                "lastIp": user["last_ip"],
                "eventCount": user["event_count"],
            },
            "events": [
                {
                    "type": e["event_type"],
                    "details": json.loads(e["details"] or "{}"),
                    "ip": e["ip"],
                    "createdAt": e["created_at"],
                }
                for e in events
            ],
        }
    )


@app.route("/admin/api/events")
@admin_required
def admin_events():
    limit = min(int(request.args.get("limit", 100)), 500)
    conn = _db()
    rows = conn.execute(
        """
        SELECT id, user_id, user_name, event_type, details, ip, user_agent, created_at
        FROM events
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out = []
    for r in rows:
        ua = parse_user_agent(r["user_agent"] or "")
        geo = resolve_geo(r["ip"]) if ENABLE_GEOIP else None
        out.append(
            {
                "id": r["id"],
                "userId": r["user_id"],
                "userName": r["user_name"],
                "type": r["event_type"],
                "details": json.loads(r["details"] or "{}"),
                "ip": r["ip"],
                "browser": ua["browser"],
                "os": ua["os"],
                "device": ua["device"],
                "geo": geo,
                "createdAt": r["created_at"],
            }
        )
    return jsonify({"events": out, "geoipEnabled": ENABLE_GEOIP})


@app.route("/admin/api/export")
@admin_required
def admin_export():
    """Download every event as a CSV for spreadsheet analysis or archiving."""
    conn = _db()
    rows = conn.execute(
        """
        SELECT id, user_id, user_name, event_type, details, ip, user_agent, created_at
        FROM events ORDER BY id ASC
        """
    ).fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(["id", "user_id", "user_name", "event_type", "details", "ip", "browser", "os", "device", "created_at"])
    for r in rows:
        ua = parse_user_agent(r["user_agent"] or "")
        writer.writerow([
            r["id"], r["user_id"], r["user_name"], r["event_type"],
            r["details"] or "", r["ip"] or "", ua["browser"], ua["os"], ua["device"],
            r["created_at"],
        ])
    payload = buf.getvalue().encode("utf-8-sig")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return Response(
        payload,
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="forge-events-{stamp}.csv"',
            "Content-Type": "text/csv; charset=utf-8",
        },
    )


@app.route("/admin/api/user/<int:user_id>/delete", methods=["POST"])
@admin_required
def admin_user_delete(user_id: int):
    """Delete a single user and all their events."""
    conn = _db()
    row = conn.execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404
    conn.execute("DELETE FROM events WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM notes WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    logger.warning("admin deleted user %s (%s) from %s", user_id, row["name"], _client_ip())
    return jsonify({"ok": True})


@app.route("/admin/api/reset", methods=["POST"])
@admin_required
def admin_reset():
    """Wipe all telemetry. Irreversible. Admin confirms in the UI."""
    conn = _db()
    conn.execute("DELETE FROM events")
    conn.execute("DELETE FROM users")
    conn.commit()
    logger.warning("admin wiped all telemetry from %s", _client_ip())
    return jsonify({"ok": True})


def _parse_iso(s: str) -> datetime:
    # Handle trailing +00:00 → Z normalization; sqlite stores with timezone.
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))


@app.route("/api/health")
def health_route():
    return jsonify({"status": "ok"})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_spa(path: str):
    """Serve the React SPA, falling back to index.html for client-side routes.

    Any path that resolves outside ``REACT_BUILD_DIR`` (e.g. traversal attempts
    via ``..``) falls through to the SPA fallback rather than leaking files.
    """
    safe = _safe_static_path(path)
    if safe:
        rel = os.path.relpath(safe, REACT_BUILD_DIR)
        return send_from_directory(REACT_BUILD_DIR, rel)
    index_path = os.path.join(REACT_BUILD_DIR, "index.html")
    if not os.path.exists(index_path):
        return jsonify({"error": "Frontend not built. Run `npm run build` in frontend/."}), 503
    return send_from_directory(REACT_BUILD_DIR, "index.html")


@app.errorhandler(RequestEntityTooLarge)
def handle_too_large(_e):
    return jsonify({"error": f"File too large. Max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."}), 413


@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        return e
    logger.exception("Unhandled exception")
    return jsonify({"error": "An unexpected error occurred."}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5023)
