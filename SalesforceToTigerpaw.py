"""Salesforce → Tigerpaw CSV converter.

Flask app exposing JSON APIs under ``/api/*`` and serving the React SPA from
``frontend/dist`` at the root.
"""

from __future__ import annotations

import io
import logging
import math
import os
import secrets
import time
import zipfile

import chardet
import pandas as pd
from flask import Flask, Response, jsonify, request, send_from_directory
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


# --- App ---------------------------------------------------------------------

REACT_BUILD_DIR = os.path.join(os.path.dirname(__file__), "frontend", "dist")
REACT_ASSETS_DIR = os.path.join(REACT_BUILD_DIR, "assets")
app = Flask(__name__, static_folder=REACT_ASSETS_DIR, static_url_path="/assets")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

_secret = os.environ.get("SECRET_KEY")
if not _secret:
    if os.environ.get("FLASK_ENV") == "production":
        raise RuntimeError("SECRET_KEY env var must be set in production")
    _secret = secrets.token_hex(32)
app.config["SECRET_KEY"] = _secret

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("SalesforceToTigerpaw")


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

    zip_buffer.seek(0)
    return Response(
        zip_buffer.getvalue(),
        mimetype="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="converted_batch.zip"',
            "X-Batch-Summary": f"{sum(1 for r in results if r['status']=='ok')}/{len(uploads)} succeeded",
        },
    )


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
