"""Unit + integration tests for SalesforceToTigerpaw."""

from __future__ import annotations

import io
import os
import sys
import unittest

import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from SalesforceToTigerpaw import (  # noqa: E402
    COLUMN_MAPPING,
    DESIRED_ORDER,
    NEW_COLUMNS,
    app,
    transform_salesforce_df,
)


def _sample_df(rows=2):
    return pd.DataFrame(
        {
            "Product Code": [f"SKU-{i}" for i in range(rows)],
            "Description": [f"Widget {i}" for i in range(rows)],
            "Quantity": [i + 1 for i in range(rows)],
            "Net Unit Price": [10.0 * (i + 1) for i in range(rows)],
            "Unit Cost": [5.0 * (i + 1) for i in range(rows)],
            "Total Price": [10.0 * (i + 1) * (i + 1) for i in range(rows)],
            "Extra": ["x"] * rows,
        }
    )


def _sample_csv_bytes(rows=2) -> bytes:
    df = _sample_df(rows)
    return df.to_csv(index=False).encode("utf-8")


class TransformTests(unittest.TestCase):
    def test_renames_mapped_columns(self):
        out = transform_salesforce_df(_sample_df())
        for src, dst in COLUMN_MAPPING.items():
            self.assertIn(dst, out.columns)
            if src != dst:
                self.assertNotIn(src, out.columns)

    def test_drops_total_price_from_source_and_re_adds_empty(self):
        out = transform_salesforce_df(_sample_df())
        # Original "Total Price" values are dropped; new empty column takes its place.
        self.assertTrue((out["Total Price"] == "").all())

    def test_adds_new_columns_when_missing(self):
        out = transform_salesforce_df(_sample_df())
        for col in NEW_COLUMNS:
            self.assertIn(col, out.columns)

    def test_reorders_columns(self):
        out = transform_salesforce_df(_sample_df())
        ordered_present = [c for c in DESIRED_ORDER if c in out.columns]
        self.assertEqual(list(out.columns)[: len(ordered_present)], ordered_present)

    def test_preserves_extra_columns_after_ordered(self):
        out = transform_salesforce_df(_sample_df())
        self.assertIn("Extra", out.columns)
        self.assertGreater(list(out.columns).index("Extra"), list(out.columns).index("Part Number"))

    def test_raises_on_missing_required_columns(self):
        bad = pd.DataFrame({"Product Code": ["A"], "Description": ["B"]})
        with self.assertRaises(ValueError):
            transform_salesforce_df(bad)


class ConvertRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_rejects_request_without_file_part(self):
        r = self.client.post("/api/convert", data={})
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.get_json())

    def test_rejects_non_csv_extension(self):
        r = self.client.post(
            "/api/convert",
            data={"file": (io.BytesIO(b"hi"), "not.txt")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 400)

    def test_rejects_empty_csv(self):
        r = self.client.post(
            "/api/convert",
            data={"file": (io.BytesIO(b""), "empty.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 400)

    def test_rejects_missing_required_columns(self):
        csv_bytes = b"Foo,Bar\n1,2\n"
        r = self.client.post(
            "/api/convert",
            data={"file": (io.BytesIO(csv_bytes), "bad.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Missing expected columns", r.get_json()["error"])

    def test_converts_valid_csv(self):
        r = self.client.post(
            "/api/convert",
            data={"file": (io.BytesIO(_sample_csv_bytes()), "in.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "text/csv")
        self.assertIn('filename="in_converted.csv"', r.headers["Content-Disposition"])
        # Header row contains the renamed column.
        first_line = r.data.splitlines()[0].decode("utf-8-sig")
        self.assertIn("Part Number", first_line)


class PreviewRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_returns_preview_json(self):
        r = self.client.post(
            "/api/preview",
            data={"file": (io.BytesIO(_sample_csv_bytes(rows=3)), "in.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["rowCount"], 3)
        self.assertIn("Product Code", body["originalColumns"])
        self.assertIn("Part Number", body["transformedColumns"])
        self.assertEqual(len(body["originalPreview"]), 3)
        self.assertEqual(body["mapping"], COLUMN_MAPPING)
        self.assertIn("Total Price", body["droppedColumns"])


class ConvertEditedRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_rejects_missing_columns(self):
        r = self.client.post("/api/convert-edited", json={"rows": []})
        self.assertEqual(r.status_code, 400)

    def test_rejects_non_list_rows(self):
        r = self.client.post(
            "/api/convert-edited", json={"columns": ["A"], "rows": "nope"}
        )
        self.assertEqual(r.status_code, 400)

    def test_serializes_edited_rows_preserving_order(self):
        body = {
            "filename": "edited.csv",
            "columns": ["Part Number", "Description", "Vendor"],
            "rows": [
                {"Part Number": "A1", "Description": "Widget", "Vendor": "ACME"},
                {"Part Number": "B2", "Description": "Gadget", "Vendor": None},
            ],
        }
        r = self.client.post("/api/convert-edited", json=body)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "text/csv")
        self.assertIn('filename="edited.csv"', r.headers["Content-Disposition"])
        lines = r.data.decode("utf-8-sig").splitlines()
        self.assertEqual(lines[0], "Part Number,Description,Vendor")
        self.assertEqual(lines[1], "A1,Widget,ACME")
        self.assertEqual(lines[2], "B2,Gadget,")


class ConvertBatchRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_rejects_empty_batch(self):
        r = self.client.post("/api/convert-batch", data={})
        self.assertEqual(r.status_code, 400)

    def test_converts_multiple_files_into_zip(self):
        import zipfile as zf

        r = self.client.post(
            "/api/convert-batch",
            data={
                "files": [
                    (io.BytesIO(_sample_csv_bytes(rows=2)), "a.csv"),
                    (io.BytesIO(_sample_csv_bytes(rows=3)), "b.csv"),
                ],
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "application/zip")
        archive = zf.ZipFile(io.BytesIO(r.data))
        names = archive.namelist()
        self.assertIn("a_converted.csv", names)
        self.assertIn("b_converted.csv", names)
        self.assertNotIn("_errors.txt", names)

    def test_partial_failure_includes_errors_file(self):
        import zipfile as zf

        bad_csv = b"Foo,Bar\n1,2\n"
        r = self.client.post(
            "/api/convert-batch",
            data={
                "files": [
                    (io.BytesIO(_sample_csv_bytes()), "good.csv"),
                    (io.BytesIO(bad_csv), "bad.csv"),
                ],
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        archive = zf.ZipFile(io.BytesIO(r.data))
        names = archive.namelist()
        self.assertIn("good_converted.csv", names)
        self.assertIn("_errors.txt", names)
        self.assertIn("bad.csv", archive.read("_errors.txt").decode())


class SpaRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_root_returns_something(self):
        # Either serves the built SPA or the "frontend not built" JSON — both fine.
        r = self.client.get("/")
        self.assertIn(r.status_code, (200, 503))

    def test_health(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
