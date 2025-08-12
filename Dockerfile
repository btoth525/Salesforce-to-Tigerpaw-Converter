FROM python:3.9-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt
EXPOSE 5023
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:5023", "SalesforceToTigerpaw:app"]