import unittest
import io
import sys
import os

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from SalesforceToTigerpaw import app


VALID_CSV_HEADERS = "Product Code,Description,Quantity,Net Unit Price,Unit Cost\n"
VALID_CSV_ROW = "ABC123,Test Widget,2,49.99,30.00\n"
VALID_CSV = VALID_CSV_HEADERS + VALID_CSV_ROW


class FlaskAppTestCase(unittest.TestCase):
    def setUp(self):
        app.config['TESTING'] = True
        self.client = app.test_client()

    def test_upload_no_file(self):
        response = self.client.post('/', data={}, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 400)
        json_data = response.get_json()
        self.assertIn('error', json_data)

    def test_upload_empty_filename(self):
        data = {'file': (io.BytesIO(b''), '')}
        response = self.client.post('/', data=data, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 400)
        json_data = response.get_json()
        self.assertIn('error', json_data)

    def test_upload_non_csv(self):
        data = {'file': (io.BytesIO(b'not a csv'), 'test.txt')}
        response = self.client.post('/', data=data, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 400)
        json_data = response.get_json()
        self.assertIn('error', json_data)

    def test_upload_valid_csv(self):
        data = {'file': (io.BytesIO(VALID_CSV.encode('utf-8')), 'test.csv')}
        response = self.client.post('/', data=data, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 200)
        self.assertIn('text/csv', response.content_type)
        self.assertIn(b'Part Number', response.data)

    def test_upload_missing_columns(self):
        bad_csv = "Wrong Column,Another Wrong Column\nfoo,bar\n"
        data = {'file': (io.BytesIO(bad_csv.encode('utf-8')), 'bad.csv')}
        response = self.client.post('/', data=data, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 400)
        json_data = response.get_json()
        self.assertIn('error', json_data)

    def test_upload_file_too_large(self):
        # 11 MB file should be rejected
        big_data = VALID_CSV_HEADERS + (VALID_CSV_ROW * 100000)
        oversized = big_data.encode('utf-8')
        # Pad to exceed 10 MB
        oversized = oversized + b'x' * (11 * 1024 * 1024)
        data = {'file': (io.BytesIO(oversized), 'big.csv')}
        response = self.client.post('/', data=data, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 413)


if __name__ == '__main__':
    unittest.main()
