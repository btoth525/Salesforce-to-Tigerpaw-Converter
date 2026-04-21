## 📖 How-To Guide

For a step-by-step tutorial, see the Scribe guide:

[How to Use Brandon's Salesforce To TigerPaw Converter](https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ)

## 📬 Contact & Support

For questions or support, contact Brandon Toth at ASAP Security Services.


# 🚀 Salesforce-to-Tigerpaw Converter

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![Publish Docker image to GHCR](https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter/actions/workflows/docker-publish.yml)



Convert Salesforce CSV reports to Tigerpaw format with a simple Python web app. Easily deployable via Docker or Unraid.

---



## 📋 Changelog
See [CHANGELOG.md](CHANGELOG.md) for update history.

---

## 🐳 Run from GHCR (Unraid / Docker / Compose)

Prebuilt multi-arch images (`linux/amd64`, `linux/arm64`) are published to
GitHub Container Registry on every push:

```bash
docker run -d --name salesforce-to-tigerpaw \
  -p 5023:5023 \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  -e FLASK_ENV=production \
  --restart unless-stopped \
  ghcr.io/btoth525/salesforce-to-tigerpaw-converter:latest
```

Open <http://YOUR-HOST:5023>. The container includes a `/api/health`
healthcheck that Unraid / Docker will surface as container health status.

**Unraid quick-add (Docker tab → Add Container → Advanced view):**

| Field | Value |
| --- | --- |
| Repository | `ghcr.io/btoth525/salesforce-to-tigerpaw-converter:latest` |
| Network Type | Bridge |
| WebUI | `http://[IP]:[PORT:5023]/` |
| Port | Host `5023` → Container `5023` |
| Env: `SECRET_KEY` | *(any long random string)* |
| Env: `FLASK_ENV` | `production` |

---

## 🆕 What's New in v1.1.0 (2026)
- `/api/preview` endpoint and redesigned frontend with drag-and-drop, column-mapping card, tabbed original↔converted table, dark/light theme, and keyboard shortcuts.
- Safer backend: route collision fixed, 10 MB upload cap, proper 400 vs 500 errors, fail-fast `SECRET_KEY`.
- Multi-stage Docker build with Gunicorn, non-root user, healthcheck.
- GitHub Actions workflow publishes multi-arch images to GHCR.

## 🆕 What's New in v1.0.2 (Aug 2025)
- Animated confetti celebration for conversions and favicon Easter egg
- Modern, beautiful React frontend (glassmorphism, gradients, responsive)
- Large animated favicon and custom branding
- Contact button for Brandon Toth
- Animated background gradients
- Footer with version, last updated, and documentation link
- Link to ScribeHow documentation
- Improved UI/UX polish, accessibility, and mobile responsiveness


---


## ✨ Features
- Converts Salesforce CSVs to Tigerpaw-compatible format
- Modern React frontend (animated confetti, glassmorphism, gradients, responsive)
- Animated favicon and custom branding
- Contact button for Brandon Toth
- Animated background gradients
- Footer with version, last updated, and documentation link
- Web interface (Flask)
- Easy deployment with Docker
- Ready for Unraid as a Docker container
- Python Flask backend for Salesforce-to-Tigerpaw CSV conversion
- Docker Compose for easy full-stack deployment

---


## 🗂️ Project Structure

```
Salesforce-to-Tigerpaw-Converter/
├── SalesforceToTigerpaw.py         # Main Flask app and CSV converter logic
├── requirements.txt                # Python dependencies
├── Dockerfile                      # Docker build instructions
├── docker-compose.yml              # Docker Compose configuration
├── frontend/                      # React frontend code
│   ├── package.json                # Frontend dependencies
│   └── src/                       # React source files
├── templates/
│   └── index.html                  # Web interface HTML
├── static/
│   └── favicon.png                 # App icon
├── uploads/                        # Uploaded files (ignored by git)
├── build/                          # Build artifacts (ignored by git)
└── README.md                       # Project documentation
```

## 🏁 Quickstart (Local)
1. **Clone the repo:**
   ```sh
   git clone https://github.com/btoth525/Salesforce-to-Tigerpaw-Converter.git
   cd Salesforce-to-Tigerpaw-Converter
   ```
2. **Create and activate a Python virtual environment:**
   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. **Install dependencies:**
   ```sh
   pip install -r requirements.txt
   ```
4. **Run the app:**
   ```sh
   python SalesforceToTigerpaw.py
   ```
   The app will run on port 5023 by default.
5. **Start the frontend (React):**
   ```sh
   cd frontend
   npm install
   npm run dev
   ```
   - React app: http://localhost:5173
   - Flask backend: http://localhost:5023
6. **Use the web interface to upload and convert your Salesforce CSV for Tigerpaw.**

## 🧑‍💻 Main Python Functions

- `process_file(input_stream)`: Reads and converts a Salesforce CSV to Tigerpaw format.
- `detect_encoding(input_stream)`: Detects file encoding for robust CSV parsing.
- `parse_csv(input_stream, encoding)`: Parses CSV with multiple delimiters.
- `transform_salesforce_df(df)`: Renames, adds, and reorders columns for Tigerpaw import.

## ⚙️ Configuration

- **Flask Secret Key**: Set in `SalesforceToTigerpaw.py` (`app.config['SECRET_KEY']`).
   For production, set this using an environment variable for better security:
   ```python
   import os
      app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'PLEASE_CHANGE_ME_SECRET_KEY')
- **Important:** Always set your own secret key in production. Never use the default placeholder value.
   ```
- **Port**: Default is `5023`. Change in the last line of `SalesforceToTigerpaw.py` if needed.
- **Uploads Folder**: Files are not saved server-side; conversion is in-memory for privacy and speed.


## 🛠️ Troubleshooting

- **Tigerpaw Import Issues**: The app now outputs CSVs with Windows line endings and a UTF-8 BOM for maximum compatibility. Tigerpaw should recognize the columns and import without errors. You no longer need to open and re-save in Excel.
- **CSV Errors**: Ensure your Salesforce export includes the required columns: `Product Code`, `Description`, `Quantity`, `Net Unit Price`, `Unit Cost`.
- **File Type**: Only `.csv` files are accepted.
- **Empty File**: The app will alert you if the uploaded file is empty or invalid.
- **Browser Issues**: Use a modern browser for best results.
- Make sure both backend and frontend are running.
- The React app posts to `http://localhost:5023/` for file conversion.
- For CORS issues, update Flask to allow requests from the frontend port.

## 🔄 Updating Dependencies

To update Python packages:
```sh
pip install --upgrade -r requirements.txt
```
Or update a specific package:
```sh
pip install --upgrade <package-name>
```


---

## 🧑‍🔧 Running in Unraid (Docker)
1. **Build the Docker image:**
   ```sh
   docker build -t salesforce-tigerpaw .
   ```
2. **Run the container:**
   ```sh
   docker run -d -p 5023:5023 --name salesforce-tigerpaw salesforce-tigerpaw
   ```
3. **Access the web interface:**
   - Open your browser and go to: `http://<your-unraid-ip>:5023`

### 🟢 Unraid Setup Tips
- Use Unraid's Docker tab to add a new container.
- Set the repository to your built image or use the CLI above.
- Map ports and volumes as needed for uploads/outputs.
- Update the container by pulling the latest repo and rebuilding the image.

---

## Deploying on Unraid (Docker)

1. Build the Docker image locally:
   ```sh
   docker build -t salesforce-tigerpaw:latest .
   ```
2. In Unraid, go to the Docker tab and add a new container.
3. Set the repository to your built image (or push to Docker Hub and use that).
4. Map port 5023 (host) to 5023 (container).
5. Set environment variables as needed (e.g., FLASK_ENV=production).
6. Start the container and access the app at `http://your-unraid-ip:5023`.

## Docker Hub Release

To publish for others:
1. Log in to Docker Hub:
   ```sh
   docker login
   ```
2. Tag your image:
   ```sh
   docker tag salesforce-tigerpaw:latest yourdockerhubusername/salesforce-tigerpaw:1.0.0
   ```
3. Push to Docker Hub:
   ```sh
   docker push yourdockerhubusername/salesforce-tigerpaw:1.0.0
   ```
4. Users can then pull and run:
   ```sh
   docker run -d -p 5023:5023 yourdockerhubusername/salesforce-tigerpaw:1.0.0
   ```

## Notes
- The app runs on port 5023 by default.
- For Unraid, you can use the Docker Compose file for advanced setups.
- For updates, tag and push new versions to Docker Hub.

## Versioning & Releases
- Tag releases in GitHub for major updates (e.g., v1.0.0, v1.1.0).
- Use semantic versioning for clarity.
- See CHANGELOG.md for update history.

## Accessibility
- The web app uses semantic HTML and ARIA attributes for better accessibility.
- Keyboard navigation and screen reader support are included.
- If you have accessibility feedback, please open an issue on GitHub.

## Error Logging
- Errors are logged using Python's logging module.
- Check server logs for troubleshooting.

## Docker Compose
- Use `docker-compose up` to run the app with future extensibility.

---

## 🤝 Contributing
Pull requests welcome! For major changes, open an issue first.

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## 📬 Contact & Support

For questions or support, contact Brandon Toth at ASAP Security Services
