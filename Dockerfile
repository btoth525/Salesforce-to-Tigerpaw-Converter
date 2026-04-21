# syntax=docker/dockerfile:1.7

# --- Stage 1: build the React frontend --------------------------------------
FROM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime --------------------------------------------------------
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter" \
      org.opencontainers.image.description="Convert Salesforce CSV reports into Tigerpaw-ready imports." \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=5023

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY SalesforceToTigerpaw.py ./
COPY --from=frontend /frontend/dist ./frontend/dist

RUN useradd --system --uid 1001 --create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 5023

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT} --workers 2 --timeout 60 SalesforceToTigerpaw:app"]
