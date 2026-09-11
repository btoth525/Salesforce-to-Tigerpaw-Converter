"""Engine tests for converter.py — no Flask involved.

Every test builds a small CSV in memory. The synthetic fixtures mirror the
shape of real Salesforce quote-line report exports (all fields quoted, LF
line endings, "1.00"-style quantities, extra report columns) without
carrying any customer data.
"""

from __future__ import annotations

import csv
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import converter  # noqa: E402
from converter import DESIRED_ORDER, Options, build_csv, clean_cell, clean_rows, convert_bytes  # noqa: E402

HEADER = ["Product Code", "Description", "Quantity", "Net Unit Price", "Unit Cost", "Group: Group Name"]


def make_csv(rows, header=HEADER, quote_all=True, newline="\n", encoding="utf-8", extra_lines=()):
    """Build CSV bytes the way Salesforce does (every field quoted, LF)."""
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_ALL if quote_all else csv.QUOTE_MINIMAL, lineterminator=newline)
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    text = buf.getvalue() + "".join(l + newline for l in extra_lines)
    return text.encode(encoding)


SAMPLE_ROWS = [
    ["Misc", "Misc", "1.00", "231.75", "139.05", "3RD FL ACCESS CONTROL (BACK BD)"],
    ["VERK - LIC-CAM-3Y-CAP", "Verkada 3-Year Camera License", "8.00", "1647.03", "329.40", "SURVEILLANCE (FRONT BD)"],
    ["CAT5 - PVC GREEN", "24-4P UNS SOL CMR C5E Grn Jkt", "1.00", "213.34", "128.00", "SURVEILLANCE (FRONT BD)"],
]


def decode_out(payload: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(payload.decode("utf-8-sig"))))


class DecodingTests(unittest.TestCase):
    def _roundtrip(self, encoding, expected_name, text="Verkada’s 3° mount"):
        rows = [["A1", text, "1.00", "1.00", "1.00", "G"]]
        data = make_csv(rows, encoding=encoding)
        r = convert_bytes(data)
        self.assertEqual(r.parse.encoding, expected_name)
        self.assertEqual(r.transformed_rows[0]["Description"], "Verkada's 3deg mount")
        return r

    def test_utf8(self):
        r = self._roundtrip("utf-8", "utf-8")
        self.assertFalse(r.parse.had_bom)

    def test_utf8_sig(self):
        r = self._roundtrip("utf-8-sig", "utf-8-sig")
        self.assertTrue(r.parse.had_bom)
        # The BOM must not leak into the first header name.
        self.assertEqual(r.parse.original_columns[0], "Product Code")

    def test_utf16_le_with_bom(self):
        r = self._roundtrip("utf-16", "utf-16")
        self.assertTrue(r.parse.had_bom)

    def test_utf16_without_bom(self):
        r = self._roundtrip("utf-16-le", "utf-16-le")
        self.assertFalse(r.parse.had_bom)

    def test_cp1252_curly_apostrophe_and_degree(self):
        # 0x92 is ’ in Windows-1252 but an invisible control char in latin-1;
        # 0xB0 is ° in both. Both must come out as ASCII.
        raw = b'"Product Code","Description","Quantity","Net Unit Price","Unit Cost"\n' \
              b'"A1","Brandon\x92s 45\xb0 bracket","1.00","2.00","1.00"\n'
        r = convert_bytes(raw)
        self.assertEqual(r.parse.encoding, "cp1252")
        self.assertEqual(r.transformed_rows[0]["Description"], "Brandon's 45deg bracket")
        kinds = {c.kind for c in r.changes}
        self.assertIn("punctuation", kinds)

    def test_invalid_bytes_fall_back_with_warning(self):
        raw = b'"Product Code","Description","Quantity","Net Unit Price","Unit Cost"\n' \
              b'"A1","bad \x81 byte","1","2","1"\n'
        r = convert_bytes(raw)
        self.assertTrue(any(w.kind == "decode_replaced" for w in r.warnings))
        self.assertTrue(all(ord(ch) < 128 for ch in r.transformed_rows[0]["Description"]))

    def test_empty_file_raises(self):
        with self.assertRaises(ValueError):
            convert_bytes(b"")
        with self.assertRaises(ValueError):
            convert_bytes(b"\n\n  \n")


class CellCleanupTests(unittest.TestCase):
    def test_mojibake_repair(self):
        new, kinds = clean_cell("Verkadaâ€™s mount", "Description", Options())
        self.assertEqual(new, "Verkada's mount")
        self.assertEqual(kinds[0], "mojibake")

    def test_smart_punctuation(self):
        new, kinds = clean_cell("“Quoted” – 24″ ½″ ™", "Description", Options())
        self.assertEqual(new, '"Quoted" - 24" 1/2" (TM)')
        self.assertEqual(kinds, ["punctuation"])

    def test_embedded_newline_collapsed(self):
        new, kinds = clean_cell("Line one\r\nLine two\nLine three", "Description", Options())
        self.assertEqual(new, "Line one Line two Line three")
        self.assertIn("linebreak", kinds)

    def test_control_chars_removed(self):
        new, kinds = clean_cell("A\x00B\x07C\tD", "Description", Options())
        self.assertEqual(new, "ABC D")
        self.assertIn("control", kinds)

    def test_whitespace_collapsed_and_trimmed(self):
        new, kinds = clean_cell("  too    many   spaces  ", "Description", Options())
        self.assertEqual(new, "too many spaces")
        self.assertEqual(kinds, ["whitespace"])

    def test_values_preserved_verbatim(self):
        for value in ("00123", "NA", "N/A", "None", "null", "3E4", "1.00", "TRUE", "-"):
            new, kinds = clean_cell(value, "Part Number", Options())
            self.assertEqual(new, value)
            self.assertEqual(kinds, [])

    def test_numeric_cleanup(self):
        cases = {
            "$1,234.56": "1234.56",
            "(12.50)": "-12.50",
            "USD 5.00": "5.00",
            "1,000": "1000",
            "-3.5": "-3.5",
            "1.00": "1.00",
            "8.00": "8.00",
        }
        for src, expected in cases.items():
            new, kinds = clean_cell(src, "Price", Options())
            self.assertEqual(new, expected, src)
            self.assertNotIn("non_numeric", kinds)

    def test_non_numeric_flagged_not_altered(self):
        new, kinds = clean_cell("TBD", "Quantity", Options())
        self.assertEqual(new, "TBD")
        self.assertIn("non_numeric", kinds)

    def test_numeric_cleanup_only_on_numeric_columns(self):
        new, kinds = clean_cell("$1,234.56", "Description", Options())
        self.assertEqual(new, "$1,234.56")
        self.assertEqual(kinds, [])

    def test_ascii_mode_strips_accents(self):
        new, kinds = clean_cell("café 中", "Description", Options(ascii_only=True))
        self.assertEqual(new, "cafe ?")
        self.assertIn("non_ascii", kinds)

    def test_unicode_mode_keeps_letters(self):
        new, kinds = clean_cell("café", "Description", Options(ascii_only=False))
        self.assertEqual(new, "café")
        self.assertEqual(kinds, [])

    def test_none_becomes_empty(self):
        self.assertEqual(clean_cell(None, "Vendor", Options()), ("", []))


class HeaderTests(unittest.TestCase):
    def test_aliases_matched_and_reported(self):
        header = ["Part Number", "Description", "Qty", "Unit Price", "Unit Cost"]
        r = convert_bytes(make_csv([["A", "B", "1", "2", "3"]], header=header))
        self.assertEqual(r.parse.aliases_used, {"Part Number": "Product Code", "Qty": "Quantity", "Unit Price": "Net Unit Price"})
        self.assertEqual(r.mapping_out["Qty"], "Quantity")
        self.assertEqual(r.transformed_rows[0]["Quantity"], "1")

    def test_cost_record_number_not_matched(self):
        header = ["Cost: Cost #", "Product Code", "Description", "Quantity", "Net Unit Price", "Unit Cost"]
        r = convert_bytes(make_csv([["C-1", "A", "B", "1", "2", "3"]], header=header))
        self.assertNotIn("Cost: Cost #", r.mapping_out)
        self.assertEqual(r.transformed_rows[0]["Cost"], "3")
        self.assertEqual(r.transformed_rows[0]["Cost: Cost #"], "C-1")

    def test_header_case_and_whitespace_insensitive(self):
        header = ["  product code ", "DESCRIPTION", "Quantity", "net unit price", "Unit  Cost"]
        r = convert_bytes(make_csv([["A", "B", "1", "2", "3"]], header=header))
        self.assertEqual(r.transformed_rows[0]["Part Number"], "A")
        self.assertEqual(r.transformed_rows[0]["Cost"], "3")

    def test_preamble_skipped(self):
        data = make_csv([["A", "B", "1", "2", "3", "G"]])
        data = b'"Quote Lines with Products"\n"As of 4/3/2025"\n\n' + data
        r = convert_bytes(data)
        self.assertEqual(r.parse.header_row_index, 3)
        self.assertEqual([s.reason for s in r.parse.skipped], ["preamble", "preamble"])
        self.assertEqual(len(r.transformed_rows), 1)

    def test_missing_columns_listed(self):
        with self.assertRaises(ValueError) as cm:
            convert_bytes(b"Foo,Bar\n1,2\n")
        msg = str(cm.exception)
        self.assertIn("Missing expected columns", msg)
        for col in converter.REQUIRED_SOURCE:
            self.assertIn(col, msg)

    def test_partial_header_reports_only_missing(self):
        header = ["Product Code", "Description", "Quantity", "Something"]
        with self.assertRaises(ValueError) as cm:
            convert_bytes(make_csv([["A", "B", "1", "x"]], header=header))
        self.assertIn("Net Unit Price", str(cm.exception))
        self.assertIn("Unit Cost", str(cm.exception))
        self.assertNotIn("Product Code", str(cm.exception))

    def test_duplicate_headers(self):
        header = ["Product Code", "Description", "Quantity", "Net Unit Price", "Unit Cost", "Description"]
        r = convert_bytes(make_csv([["A", "first", "1", "2", "3", "second"]], header=header))
        self.assertIn("Description (2)", r.parse.original_columns)
        self.assertEqual(r.transformed_rows[0]["Description"], "first")
        self.assertEqual(r.transformed_rows[0]["Description (2)"], "second")
        self.assertTrue(any(w.kind == "duplicate_header" for w in r.warnings))

    def test_semicolon_delimiter(self):
        data = make_csv([["A", "B;x", "1", "2", "3", "G"]]).decode().replace(",", ";").encode()
        r = convert_bytes(data)
        self.assertEqual(r.parse.delimiter, ";")
        self.assertEqual(r.transformed_rows[0]["Description"], "B;x")

    def test_tab_delimiter(self):
        data = make_csv([["A", "B", "1", "2", "3", "G"]], quote_all=False).decode().replace(",", "\t").encode()
        r = convert_bytes(data)
        self.assertEqual(r.parse.delimiter, "\t")
        self.assertEqual(r.transformed_rows[0]["Part Number"], "A")


class RowDropTests(unittest.TestCase):
    def test_salesforce_footer_dropped(self):
        footer = [
            "",
            "",
            '"Quote Lines Report"',
            '"Copyright (c) 2000-2026 salesforce.com, inc. All rights reserved."',
            '"Confidential Information - Do Not Distribute"',
            '"Generated By:  Brandon Toth  9/8/2026 11:22 AM"',
            '"ASAP Security Services"',
        ]
        r = convert_bytes(make_csv(SAMPLE_ROWS, extra_lines=footer))
        self.assertEqual(len(r.transformed_rows), 3)
        reasons = [s.reason for s in r.parse.skipped]
        self.assertEqual(reasons.count("blank"), 2)
        self.assertEqual(reasons.count("footer"), 5)
        self.assertTrue(any("Copyright" in s.preview for s in r.parse.skipped))

    def test_footer_without_blank_line_dropped(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS, extra_lines=['"Copyright (c) 2026 salesforce.com"']))
        self.assertEqual(len(r.transformed_rows), 3)
        self.assertEqual(r.parse.skipped[0].reason, "footer")

    def test_grand_totals_row_dropped(self):
        rows = SAMPLE_ROWS + [["", "Grand Totals (3 records)", "10.00", "2092.12", "596.45", ""]]
        r = convert_bytes(make_csv(rows))
        self.assertEqual(len(r.transformed_rows), 3)
        self.assertEqual(r.parse.skipped[0].reason, "totals")

    def test_legit_total_product_kept(self):
        rows = [["TOT-1", "Total Connect Kit", "1", "2", "3", "G"]]
        r = convert_bytes(make_csv(rows))
        self.assertEqual(len(r.transformed_rows), 1)

    def test_ragged_row_padded_with_warning(self):
        data = make_csv(SAMPLE_ROWS) + b'"X","short row"\n'
        r = convert_bytes(data)
        self.assertEqual(len(r.transformed_rows), 4)
        self.assertEqual(r.transformed_rows[3]["Quantity"], "")
        self.assertTrue(any(w.kind == "ragged_row" for w in r.warnings))

    def test_skipped_row_indexes(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS, extra_lines=["", '"Copyright"']))
        self.assertEqual([(s.index, s.line) for s in r.parse.skipped], [(3, 5), (4, 6)])


class TransformTests(unittest.TestCase):
    def test_column_order_and_added(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS))
        self.assertEqual(r.transformed_columns[: len(DESIRED_ORDER)], DESIRED_ORDER)
        self.assertEqual(r.transformed_columns[len(DESIRED_ORDER):], ["Group: Group Name"])
        self.assertEqual(sorted(r.added_columns), sorted(converter.NEW_COLUMNS))
        for col in converter.NEW_COLUMNS:
            self.assertEqual(r.transformed_rows[0][col], "")

    def test_total_price_dropped_and_re_added_empty(self):
        header = HEADER[:5] + ["Total Price"]
        r = convert_bytes(make_csv([["A", "B", "2.00", "5.00", "1.00", "10.00"]], header=header))
        self.assertEqual(r.dropped_columns, ["Total Price"])
        self.assertEqual(r.transformed_rows[0]["Total Price"], "")
        self.assertEqual(r.transformed_columns.count("Total Price"), 1)

    def test_source_list_price_feeds_target(self):
        header = HEADER[:5] + ["List Price"]
        r = convert_bytes(make_csv([["A", "B", "1", "2", "3", "99.00"]], header=header))
        self.assertEqual(r.transformed_rows[0]["List Price"], "99.00")
        self.assertNotIn("List Price", r.added_columns)
        self.assertEqual(r.transformed_columns.count("List Price"), 1)

    def test_keep_extras_false(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS), Options(keep_extras=False))
        self.assertEqual(r.transformed_columns, DESIRED_ORDER)

    def test_group_as_phase(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS), Options(group_as_phase=True))
        self.assertEqual(r.transformed_rows[0]["Project Phase"], "3RD FL ACCESS CONTROL (BACK BD)")
        self.assertEqual(r.mapping_out["Group: Group Name"], "Project Phase")
        self.assertNotIn("Group: Group Name", r.transformed_columns)
        self.assertNotIn("Project Phase", r.added_columns)

    def test_changes_reference_output_columns_and_rows(self):
        rows = [["A", "plain", "1", "1", "1", "G"], ["B", "curly’s", "$2.00", "1", "1", "G"]]
        r = convert_bytes(make_csv(rows))
        by_cell = {(c.row, c.column): c for c in r.changes}
        self.assertEqual(by_cell[(1, "Description")].to, "curly's")
        self.assertEqual(by_cell[(1, "Description")].from_, "curly’s")
        self.assertEqual(by_cell[(1, "Quantity")].kind, "number")
        self.assertEqual(len(r.changes), 2)

    def test_row_level_warnings(self):
        rows = [["", "", "x", "1", "1", "G"]]
        r = convert_bytes(make_csv(rows))
        kinds = {w.kind for w in r.warnings}
        self.assertEqual(kinds, {"empty_part_number", "empty_description", "non_numeric"})

    def test_extras_cleaned_too(self):
        rows = [["A", "B", "1", "1", "1", "Phase – one\nline two"]]
        r = convert_bytes(make_csv(rows))
        self.assertEqual(r.transformed_rows[0]["Group: Group Name"], "Phase - one line two")

    def test_round_trip_fidelity_on_sample_shape(self):
        data = make_csv(SAMPLE_ROWS)
        r = convert_bytes(data)
        self.assertEqual(r.parse.encoding, "utf-8")
        self.assertEqual(len(r.transformed_rows), len(SAMPLE_ROWS))
        self.assertEqual(r.changes, [])
        self.assertEqual(r.warnings, [])
        self.assertEqual(r.parse.skipped, [])
        for src, out in zip(SAMPLE_ROWS, r.transformed_rows):
            self.assertEqual(out["Part Number"], src[0])
            self.assertEqual(out["Description"], src[1])
            self.assertEqual(out["Quantity"], src[2])  # "1.00" stays "1.00"
            self.assertEqual(out["Price"], src[3])
            self.assertEqual(out["Cost"], src[4])
            self.assertEqual(out["Group: Group Name"], src[5])
        out_rows = decode_out(r.to_csv())
        self.assertEqual(len(out_rows), len(SAMPLE_ROWS) + 1)
        self.assertEqual(out_rows[1][:5], SAMPLE_ROWS[0][:5])

    def test_summary(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS, extra_lines=["", '"Copyright"']))
        self.assertEqual(r.summary(), {"rows": 3, "skipped": 2, "changes": 0, "warnings": 0, "encoding": "utf-8"})


class OutputTests(unittest.TestCase):
    def test_default_bom_and_crlf(self):
        out = convert_bytes(make_csv(SAMPLE_ROWS)).to_csv()
        self.assertTrue(out.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b"\r\n", out)
        self.assertNotIn(b"\n\n", out)
        body = out[3:]
        self.assertEqual(body.count(b"\n"), body.count(b"\r\n"))

    def test_no_bom_option(self):
        out = convert_bytes(make_csv(SAMPLE_ROWS), Options(bom=False)).to_csv()
        self.assertFalse(out.startswith(b"\xef\xbb\xbf"))
        self.assertTrue(out.startswith(b"Part Number,"))

    def test_quote_all(self):
        out = convert_bytes(make_csv(SAMPLE_ROWS), Options(quote_all=True)).to_csv()
        first = out.decode("utf-8-sig").splitlines()[0]
        self.assertTrue(first.startswith('"Part Number","Description"'))
        second = out.decode("utf-8-sig").splitlines()[1]
        self.assertTrue(second.startswith('"Misc","Misc","1.00"'))

    def test_minimal_quoting_default(self):
        out = convert_bytes(make_csv(SAMPLE_ROWS)).to_csv()
        second = out.decode("utf-8-sig").splitlines()[1]
        self.assertTrue(second.startswith("Misc,Misc,1.00,"))

    def test_minimal_quoting_still_quotes_delimiters(self):
        rows = [["A", "Cable, 24-4P", "1", "1", "1", "G"]]
        out = convert_bytes(make_csv(rows)).to_csv().decode("utf-8-sig")
        self.assertIn('"Cable, 24-4P"', out)

    def test_ascii_only_output_has_no_high_bytes(self):
        rows = [["A", "Café – “quoted” ½″ 中", "1", "1", "1", "°"]]
        out = convert_bytes(make_csv(rows)).to_csv()
        self.assertTrue(all(b < 128 for b in out[3:]))

    def test_unicode_mode_keeps_utf8(self):
        rows = [["A", "Café", "1", "1", "1", "G"]]
        out = convert_bytes(make_csv(rows), Options(ascii_only=False)).to_csv()
        self.assertIn("Café".encode("utf-8"), out)

    def test_build_csv_none_and_missing(self):
        out = build_csv(["A", "B"], [{"A": None}, {"B": "x"}], Options(bom=False))
        self.assertEqual(out, b"A,B\r\n,\r\n,x\r\n")

    def test_options_from_mapping_strings(self):
        o = Options.from_mapping({"asciiOnly": "false", "bom": "0", "quoteAll": "true", "keepExtras": "no", "groupAsPhase": "1"})
        self.assertEqual(o, Options(ascii_only=False, bom=False, quote_all=True, keep_extras=False, group_as_phase=True))
        self.assertEqual(Options.from_mapping({}), Options())
        self.assertEqual(Options.from_mapping(None), Options())
        self.assertEqual(Options().to_dict()["asciiOnly"], True)


class EditedPathTests(unittest.TestCase):
    def test_clean_rows_applies_cleanup(self):
        cols = ["Part Number", "Description", "Quantity"]
        rows = [{"Part Number": "A", "Description": "pasted ’quote’\nnext", "Quantity": "$3"}]
        cleaned, changes, warnings = clean_rows(cols, rows, Options())
        self.assertEqual(cleaned[0]["Description"], "pasted 'quote' next")
        self.assertEqual(cleaned[0]["Quantity"], "3")
        self.assertEqual(len(changes), 2)
        self.assertEqual(warnings, [])

    def test_clean_rows_preview_payload_shape(self):
        r = convert_bytes(make_csv(SAMPLE_ROWS, extra_lines=["", '"Copyright"']))
        payload = converter.preview_payload(r, "x.csv", 2)
        for key in ("filename", "rowCount", "previewLimit", "truncated", "encoding", "hadBom",
                    "delimiter", "headerRowIndex", "originalColumns", "transformedColumns",
                    "originalPreview", "transformedPreview", "mapping", "aliasesUsed",
                    "addedColumns", "droppedColumns", "skippedRows", "changes", "warnings",
                    "changesTruncated", "warningsTruncated", "options"):
            self.assertIn(key, payload)
        self.assertTrue(payload["truncated"])
        self.assertEqual(len(payload["transformedPreview"]), 2)
        self.assertEqual(payload["rowCount"], 3)
        self.assertEqual(payload["skippedRows"][1]["reason"], "footer")
        self.assertEqual(payload["options"], Options().to_dict())


if __name__ == "__main__":
    unittest.main()


class TotalsInFirstColumnTests(unittest.TestCase):
    def test_grand_totals_label_in_part_number_column_is_dropped(self):
        import converter
        data = (
            '"Product Code","Description","Quantity","Net Unit Price","Unit Cost"\n'
            '"A-1","Widget","1","10.00","5.00"\n'
            '"Grand Totals (1 records)","","","10.00",""\n'
        ).encode("utf-8")
        result = converter.convert_bytes(data, converter.Options())
        self.assertEqual(result.summary()["rows"], 1)
        self.assertEqual([s.reason for s in result.parse.skipped], ["totals"])

    def test_product_named_total_is_kept(self):
        import converter
        data = (
            '"Product Code","Description","Quantity","Net Unit Price","Unit Cost"\n'
            '"TOTAL-CTRL","Total Control panel","2","10.00","5.00"\n'
        ).encode("utf-8")
        result = converter.convert_bytes(data, converter.Options())
        self.assertEqual(result.summary()["rows"], 1)
        self.assertEqual(result.parse.skipped, [])


class MojibakeC1Tests(unittest.TestCase):
    def test_repairs_mojibake_containing_undefined_cp1252_bytes(self):
        import converter
        # ” is E2 80 9D in UTF-8; 0x9D is undefined in cp1252 and shows up as U+009D.
        original = "Dome \u201cindoor\u201d"
        garbled = original.encode("utf-8").decode("latin-1")
        fixed, kinds = converter.clean_cell(garbled, "Description", converter.Options())
        self.assertEqual(fixed, 'Dome "indoor"')
        self.assertIn("mojibake", kinds)
