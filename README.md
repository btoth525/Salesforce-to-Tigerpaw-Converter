## 📖 How-To Guide

For a step-by-step tutorial, see the Scribe guide:

[How to Use Brandon's Salesforce To TigerPaw Converter](https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ)

## 📬 Contact & Support

For questions or support, contact Brandon Toth at ASAP Security Services.


# 🚀 Salesforce-to-Tigerpaw Converter

![Version](https://img.shields.io/badge/version-1.0-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
<!-- If you add CI/CD, add a status badge here -->



Convert Salesforce CSV reports to Tigerpaw format with a simple Python web app. Easily deployable via Docker or Unraid.

---


## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for update history.


---

## ✨ Features
- Converts Salesforce CSVs to Tigerpaw-compatible format
- Web interface (Flask)
- Easy deployment with Docker
- Ready for Unraid as a Docker container

---


## 🗂️ Project Structure

```
Salesforce-to-Tigerpaw-Converter/
├── SalesforceToTigerpaw.py         # Main Flask app and CSV converter logic
├── requirements.txt                # Python dependencies
├── Dockerfile                      # Docker build instructions
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

- **CSV Errors**: Ensure your Salesforce export includes the required columns: `Product Code`, `Description`, `Quantity`, `Net Unit Price`, `Unit Cost`.
- **File Type**: Only `.csv` files are accepted.
- **Empty File**: The app will alert you if the uploaded file is empty or invalid.
- **Browser Issues**: Use a modern browser for best results.

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

## 🤝 Contributing
Pull requests welcome! For major changes, open an issue first.

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## 📬 Contact & Support

For questions or support, contact Brandon Toth at ASAP Security Services.
