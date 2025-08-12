# Salesforce to Tigerpaw Converter

A web application to convert Salesforce report CSV files into a format compatible with Tigerpaw, built with Flask and Pandas.

## Features

- Upload Salesforce CSV files via a modern web interface
- Automatic encoding and delimiter detection
- Column mapping and formatting for Tigerpaw import
- Download the converted CSV instantly
- Responsive, dark-mode enabled UI

## Getting Started

### Prerequisites

- Python 3.8+
- pip

### Installation

1. Clone the repository:
   ```sh
   git clone https://github.com/btoth525/Docker-To-SalesForce-CSV.git
   cd Docker-To-SalesForce-CSV
   ```

2. Install dependencies:
   ```sh
   pip install -r requirements.txt
   ```

### Running the App

```sh
python SalesforceToTigerpaw.py
```

The app will be available at `http://localhost:5023`.

## Usage

1. Open the web interface.
2. Drag and drop or select your Salesforce CSV file.
3. Click "Convert" to download the Tigerpaw-compatible CSV.

## Project Structure

- `SalesforceToTigerpaw.py` — Main Flask app
- `templates/index.html` — Web UI
- `static/` — Static assets (favicon, etc.)
- `requirements.txt` — Python dependencies

## Contributing

Pull requests are welcome! For major changes, please open an issue first.

## License

MIT
