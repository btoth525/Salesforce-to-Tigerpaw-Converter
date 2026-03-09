# Stage 1: Build React frontend
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY SalesforceToTigerpaw.py .
COPY --from=frontend-builder /frontend/dist ./frontend/dist
EXPOSE 5023
CMD ["gunicorn", "--bind", "0.0.0.0:5023", "--workers", "2", "--timeout", "60", "SalesforceToTigerpaw:app"]
