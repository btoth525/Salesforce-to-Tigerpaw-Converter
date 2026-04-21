# Dockerfile for Flask backend
FROM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=frontend /frontend/dist ./frontend/dist
EXPOSE 5023
CMD ["gunicorn", "--bind", "0.0.0.0:5023", "--workers", "2", "--timeout", "60", "SalesforceToTigerpaw:app"]
