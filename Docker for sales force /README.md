# 🚀 Docker-To-SalesForce-CSV

Convert Salesforce CSV reports to Tigerpaw format with a simple Python app, packaged for Docker and Unraid.

---

## ✨ Features
- 🔄 Converts Salesforce CSVs to Tigerpaw-compatible format
- 🌐 Web interface (Flask)
- 🐳 Easy deployment with Docker
- 🧑‍💻 Ready for Unraid as a Docker container

---

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

---

## 🧑‍🔧 Running in Unraid (Docker)
1. **Build the Docker image:**
   ```sh
   docker build -t salesforce-tigerpaw .
   ```
2. **Run the container:**
   ```sh
   docker run -d -p 5000:5000 --name salesforce-tigerpaw salesforce-tigerpaw
   ```
3. **Access the web interface:**
   - Open your browser and go to: `http://<your-unraid-ip>:5000`

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
MIT
