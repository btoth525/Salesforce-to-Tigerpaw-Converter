import pandas as pd
from flask import Flask, request, render_template, Response, jsonify
import io
from werkzeug.utils import secure_filename
import os
import chardet

# Initialize Flask App
app = Flask(__name__)
app.config['SECRET_KEY'] = 'Windfern1!'


# Core Processing Function
def process_file(input_stream):
    """Reads Salesforce CSV from stream, processes, and returns as BytesIO."""
    try:
        # Read raw bytes to detect encoding
        raw_data = input_stream.read()
        if not raw_data:
            raise ValueError("The uploaded CSV file is empty.")
        input_stream.seek(0)

        # Detect encoding
        result = chardet.detect(raw_data)
        encoding = result['encoding'] or 'utf-8'

        # Try parsing with different delimiters
        delimiters = [',', ';', '\t']
        salesforce_df = None
        for delim in delimiters:
            try:
                input_stream.seek(0)
                salesforce_df = pd.read_csv(input_stream, encoding=encoding, delimiter=delim, skip_blank_lines=True)
                if not salesforce_df.empty:
                    break
            except pd.errors.ParserError:
                continue
        if salesforce_df is None or salesforce_df.empty:
            raise ValueError("The uploaded CSV file is empty or could not be parsed.")

        # Column mapping for renaming
        column_mapping = {
            "Product Code": "Part Number",
            "Description": "Description",
            "Quantity": "Quantity",
            "Net Unit Price": "Price",
            "Unit Cost": "Cost"
        }
        missing_rename_cols = [col for col in column_mapping.keys() if col not in salesforce_df.columns]
        if missing_rename_cols:
            raise ValueError(f"Missing expected columns in CSV: {', '.join(missing_rename_cols)}")

        # Rename columns
        transformed_df = salesforce_df.rename(columns=column_mapping)

        # Drop unnecessary columns
        columns_to_drop = ["Total Price"]
        transformed_df = transformed_df.drop(columns=[col for col in columns_to_drop if col in transformed_df.columns],
                                             errors='ignore')

        # Add new empty columns
        new_empty_columns = ["Type", "List Price", "Vendor", "Vendor Part number", "Project Phase",
                             "Installation Location", "Total Price", "UOM"]
        for col in new_empty_columns:
            if col not in transformed_df.columns:
                transformed_df[col] = ""

        # Define desired column order
        desired_column_order = [
            "Part Number", "Description", "Quantity", "Price", "Cost", "Total Price",
            "Type", "List Price", "UOM", "Vendor", "Vendor Part number", "Project Phase", "Installation Location"
        ]
        final_columns_ordered = [col for col in desired_column_order if col in transformed_df.columns]
        other_existing_columns = [col for col in transformed_df.columns if col not in final_columns_ordered]
        final_ordered_df = transformed_df[final_columns_ordered + other_existing_columns]

        # Save to BytesIO
        output_stream = io.StringIO()
        final_ordered_df.to_csv(output_stream, index=False, encoding='utf-8')
        output_stream.seek(0)
        # Convert to BytesIO for binary response
        binary_stream = io.BytesIO(output_stream.getvalue().encode('utf-8'))
        binary_stream.seek(0)
        return binary_stream
    except pd.errors.EmptyDataError:
        raise ValueError("The uploaded CSV file is empty or could not be parsed")
    except pd.errors.ParserError as e:
        raise ValueError(f"Invalid CSV format: {str(e)}")
    except ValueError as e:
        raise
    except Exception as e:
        raise Exception(f"An unexpected error occurred: {str(e)}")

# Flask Routes
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
            # Process file in memory
            binary_stream = process_file(file.stream)
            # Stream the file back to the client (send bytes, not BytesIO object)
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
    # GET Request
    return render_template('index.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5023)