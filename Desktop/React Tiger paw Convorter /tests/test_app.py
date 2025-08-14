import unittest
from frontend.SalesforceToTigerpaw import app

class FlaskAppTestCase(unittest.TestCase):
    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True

    def test_index_page(self):
        response = self.app.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Salesforce to Tigerpaw Converter', response.data)

    def test_upload_no_file(self):
        response = self.app.post('/', data={})
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'No file chosen', response.data)

if __name__ == '__main__':
    unittest.main()
