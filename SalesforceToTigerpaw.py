
import pandas as pd
from flask import Flask, request, render_template, Response, jsonify
import io
from werkzeug.utils import secure_filename
import os
import chardet

# --- Flask App Initialization ---
import os
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'Windfern1!')


def detect_encoding(input_stream):
    """Detect file encoding using chardet."""
    raw_data = input_stream.read()
    input_stream.seek(0)
    result = chardet.detect(raw_data)
    return result['encoding'] or 'utf-8'

def parse_csv(input_stream, encoding):
    """Try parsing CSV with common delimiters."""
    delimiters = [',', ';', '\t']
    for delim in delimiters:
        input_stream.seek(0)
        try:
            df = pd.read_csv(input_stream, encoding=encoding, delimiter=delim, skip_blank_lines=True)
            if not df.empty:
                return df
        except pd.errors.ParserError:
            continue
    return None

def transform_salesforce_df(df):
    """Transform Salesforce DataFrame to Tigerpaw format."""
    column_mapping = {
        "Product Code": "Part Number",
        "Description": "Description",
        "Quantity": "Quantity",
        "Net Unit Price": "Price",
        "Unit Cost": "Cost"
    }
    missing_cols = [col for col in column_mapping if col not in df.columns]
    if missing_cols:
        raise ValueError(f"Missing expected columns in CSV: {', '.join(missing_cols)}")
    df = df.rename(columns=column_mapping)
    # Drop unnecessary columns
    df = df.drop(columns=[col for col in ["Total Price"] if col in df.columns], errors='ignore')
    # Add new empty columns
    new_cols = ["Type", "List Price", "Vendor", "Vendor Part number", "Project Phase",
                "Installation Location", "Total Price", "UOM"]
    for col in new_cols:
        if col not in df.columns:
            df[col] = ""
    # Reorder columns
    desired_order = [
        "Part Number", "Description", "Quantity", "Price", "Cost", "Total Price",
        "Type", "List Price", "UOM", "Vendor", "Vendor Part number", "Project Phase", "Installation Location"
    ]
    ordered = [col for col in desired_order if col in df.columns]
    others = [col for col in df.columns if col not in ordered]
    return df[ordered + others]

def process_file(input_stream):
    """Reads Salesforce CSV from stream, processes, and returns as BytesIO."""
    try:
        encoding = detect_encoding(input_stream)
        df = parse_csv(input_stream, encoding)
        if df is None or df.empty:
            raise ValueError("The uploaded CSV file is empty or could not be parsed.")
        transformed_df = transform_salesforce_df(df)
        output_stream = io.StringIO()
        transformed_df.to_csv(output_stream, index=False, encoding='utf-8')
        output_stream.seek(0)
        binary_stream = io.BytesIO(output_stream.getvalue().encode('utf-8'))
        binary_stream.seek(0)
        return binary_stream
    except pd.errors.EmptyDataError:
        raise ValueError("The uploaded CSV file is empty or could not be parsed.")
    except pd.errors.ParserError as e:
        raise ValueError(f"Invalid CSV format: {str(e)}")
    except ValueError as e:
        raise
    except Exception as e:
        raise Exception(f"An unexpected error occurred: {str(e)}")

# --- Flask Routes ---
@app.route('/', methods=['GET', 'POST'])
def upload_file_route():
    if request.method == 'POST':
        if 'file' not in request.files:
            return jsonify({"error": "No file part in the request."}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({"error": "No file selected."}), 400
        if not file.filename.lower().endswith('.csv'):
            return jsonify({"error": "Invalid file type. Please upload a CSV file."}), 400

        filename = secure_filename(file.filename)
        output_filename = os.path.splitext(filename)[0] + "_converted.csv"
        try:
            binary_stream = process_file(file.stream)
            return Response(
                binary_stream.getvalue(),
                mimetype='text/csv',
                headers={
                    'Content-Disposition': f'attachment; filename="{output_filename}"',
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            )
        except (ValueError, Exception) as e:
            return jsonify({"error": f"Error processing file: {str(e)}"}), 400
    return render_template('index.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5023)