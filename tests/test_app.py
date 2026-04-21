"""Unit + integration tests for SalesforceToTigerpaw."""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest

import pandas as pd

# Point the app at a fresh on-disk DB before import so tests don't share state
# with whatever ran last on this machine.
_TEST_DATA_DIR = tempfile.mkdtemp(prefix="forge-test-")
os.environ["FORGE_DATA_DIR"] = _TEST_DATA_DIR
os.environ.setdefault("ADMIN_PASSWORD", "testpw")

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

    def test_traversal_attempt_falls_back_to_spa_or_503(self):
        # A path that tries to escape the build dir must not leak /etc/passwd
        # or any other file. The expected behavior is the SPA fallback (200
        # index.html) or 503 if the frontend isn't built — never a 200 with
        # the traversal target's contents.
        r = self.client.get("/../../etc/passwd")
        self.assertIn(r.status_code, (200, 404, 503))
        self.assertNotIn(b"root:", r.data)

    def test_encoded_traversal_attempt_is_safe(self):
        r = self.client.get("/%2e%2e/%2e%2e/etc/passwd")
        self.assertIn(r.status_code, (200, 404, 503))
        self.assertNotIn(b"root:", r.data)


class UploadLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_oversize_upload_returns_413(self):
        # MAX_CONTENT_LENGTH is 10 MB; 11 MB of junk should be rejected before
        # we even parse the CSV.
        big = io.BytesIO(b"a,b,c\n" + b"0," * (11 * 1024 * 1024 // 2))
        r = self.client.post(
            "/api/convert",
            data={"file": (big, "big.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 413)
        self.assertIn("error", r.get_json())


class IdentifyAndAdminTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def _login(self):
        r = self.client.post("/admin/login", data={"password": "testpw"})
        self.assertIn(r.status_code, (302, 303))

    def test_identify_creates_user_and_event(self):
        r = self.client.post(
            "/api/identify",
            json={"name": "Brandon T.", "firstTime": True},
            headers={"User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120"},
        )
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["name"], "Brandon T.")
        self.assertTrue(body["ok"])

    def test_admin_routes_require_login(self):
        r = self.client.get("/admin/api/stats")
        self.assertEqual(r.status_code, 401)
        r2 = self.client.get("/admin")
        self.assertEqual(r2.status_code, 302)  # redirect to login

    def test_admin_login_wrong_password(self):
        r = self.client.post("/admin/login", data={"password": "nope"})
        self.assertEqual(r.status_code, 401)

    def test_admin_flow_stats_and_events(self):
        # Perform a convert so there's something to see.
        csv_bytes = _sample_csv_bytes(rows=2)
        self.client.post(
            "/api/convert",
            data={"file": (io.BytesIO(csv_bytes), "hit.csv")},
            content_type="multipart/form-data",
            headers={"X-User-Name": "Tester", "User-Agent": "Mozilla/5.0 Chrome/120"},
        )
        self._login()
        stats = self.client.get("/admin/api/stats").get_json()
        self.assertGreaterEqual(stats["totalEvents"], 1)
        self.assertGreaterEqual(stats["totalUsers"], 1)

        events = self.client.get("/admin/api/events?limit=5").get_json()
        self.assertTrue(any(e["type"] == "convert" for e in events["events"]))

        users = self.client.get("/admin/api/users").get_json()
        tester = next((u for u in users["users"] if u["name"] == "Tester"), None)
        self.assertIsNotNone(tester)
        self.assertGreaterEqual(tester["eventCount"], 1)

        detail = self.client.get(f"/admin/api/user/{tester['id']}").get_json()
        self.assertEqual(detail["user"]["name"], "Tester")
        self.assertTrue(len(detail["events"]) >= 1)

    def test_reset_wipes_telemetry(self):
        self._login()
        # Generate an event
        self.client.post(
            "/api/convert",
            data={"file": (io.BytesIO(_sample_csv_bytes()), "hit.csv")},
            content_type="multipart/form-data",
            headers={"X-User-Name": "ToDelete"},
        )
        r = self.client.post("/admin/api/reset")
        self.assertEqual(r.status_code, 200)
        stats = self.client.get("/admin/api/stats").get_json()
        self.assertEqual(stats["totalUsers"], 0)
        self.assertEqual(stats["totalEvents"], 0)


if __name__ == "__main__":
    unittest.main()
