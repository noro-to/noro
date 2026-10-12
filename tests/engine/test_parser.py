"""Number parser: formats that must parse, identifiers and dates that must not."""
import unittest

from engine_helpers import noro

# (text, expected raw, value, kind, unit) for the first number found
MUST_PARSE = [
    ("Spend was $48,213 this week.", "$48,213", 48213.0, "currency", "USD"),
    ("Spend was $48.2k.", "$48.2k", 48200.0, "currency", "USD"),
    ("Spend was $48.2K.", "$48.2K", 48200.0, "currency", "USD"),
    ("Budget is $1.2M.", "$1.2M", 1200000.0, "currency", "USD"),
    ("Budget is $1.2MM.", "$1.2MM", 1200000.0, "currency", "USD"),
    ("Budget is $2.5 million.", "$2.5 million", 2500000.0, "currency", "USD"),
    ("Revenue hit £3.5bn.", "£3.5bn", 3.5e9, "currency", "GBP"),
    ("Spend €1,204.50 in total.", "€1,204.50", 1204.5, "currency", "EUR"),
    ("Spend USD 1,500 in total.", "USD 1,500", 1500.0, "currency", "USD"),
    ("Spend 1,500 EUR in total.", "1,500 EUR", 1500.0, "currency", "EUR"),
    ("Refunds were -$1,200.", "-$1,200", -1200.0, "currency", "USD"),
    ("CTR rose 12%.", "12%", 12.0, "percent", "%"),
    ("CTR rose 12 percent.", "12 percent", 12.0, "percent", "%"),
    ("CPA moved -3.1% week over week.", "-3.1%", -3.1, "percent", "%"),
    ("CPA moved −3.1% week over week.", "−3.1%", -3.1, "percent", "%"),
    ("CVR moved +4.5% on mobile.", "+4.5%", 4.5, "percent", "%"),
    ("CVR rose +0.3 pp on mobile.", "+0.3 pp", 0.3, "pp", "pp"),
    ("CVR fell 1.2pp on mobile.", "1.2pp", 1.2, "pp", "pp"),
    ("CVR fell 2 percentage points.", "2 percentage points", 2.0, "pp", "pp"),
    ("CVR fell 0.4% points.", "0.4% points", 0.4, "pp", "pp"),
    ("CVR fell 30 bps.", "30 bps", 0.3, "pp", "pp"),
    ("ROAS 4.1 on brand.", "4.1", 4.1, "multiplier", "x"),
    ("ROAS was 4.1 on brand.", "4.1", 4.1, "multiplier", "x"),
    ("A 4.1 ROAS on brand.", "4.1", 4.1, "multiplier", "x"),
    ("Brand returned 4.1x.", "4.1x", 4.1, "multiplier", "x"),
    ("A 3× lift on brand.", "3×", 3.0, "multiplier", "x"),
    ("We got 790 conversions.", "790", 790.0, "count", ""),
    ("We got 1,234 clicks.", "1,234", 1234.0, "count", ""),
    ("We got 12,345,678 impressions.", "12,345,678", 12345678.0, "count", ""),
    ("Mon 16.4 per day.", "16.4", 16.4, "count", ""),
    ("We got 0.85 clicks per user.", "0.85", 0.85, "count", ""),
    ("We got 1.2M impressions.", "1.2M", 1200000.0, "count", ""),
    ("We got 48k impressions.", "48k", 48000.0, "count", ""),
    ("We got 1999 clicks.", "1999", 1999.0, "count", ""),
    ("We spent $2,026 on it.", "$2,026", 2026.0, "currency", "USD"),
    ("## Spend up 12%", "12%", 12.0, "percent", "%"),
    ("1. CPA rose 39% to $61", "39%", 39.0, "percent", "%"),
    ("Spend in March 12% higher.", "12%", 12.0, "percent", "%"),
    ("A 7-day window.", "7", 7.0, "count", ""),
]

# Text that holds digits but no metric number.
MUST_NOT_PARSE = [
    "PR-03", "See PR-03 for details.", "SKU-1234", "Q4", "Q4 results", "W45", "In W45 we paused.",
    "2026", "May–August 2026", "Oct 12", "Oct 12, 2026", "12 Oct", "October 3rd",
    "Oct 6–12", "6–12 Oct", "Sep 29–Oct 5",
    "2026-10-12", "2026-10", "10/12", "10/12/2026", "9:30am", "14:00 UTC", "3pm",
    "top 3", "Top 10 keywords", "the top-3 campaigns", "#3", "No. 2", "step 2", "Tier 1",
    "v1.2", "v2", "version 2", "release 1.2.3", "## 2. Results", "### 3 Spend", "## 2.1 Spend",
    "1. First item", "2) Second item", "H1 2026", "Q4'26", "FY2026", "footnote[1]",
    "the 3rd week", "5G", "B2B", "https://example.com/report/2026/10?id=45",
]


def first(text):
    nums = noro.extract_numbers(text)
    return nums[0] if nums else None


class MustParse(unittest.TestCase):
    def test_formats(self):
        for text, raw, value, kind, unit in MUST_PARSE:
            with self.subTest(text=text):
                n = first(text)
                self.assertIsNotNone(n, f"nothing parsed from {text!r}")
                self.assertEqual(n["raw"], raw)
                self.assertAlmostEqual(n["value"], value, places=6)
                self.assertEqual(n["kind"], kind)
                self.assertEqual(n["unit"], unit)

    def test_span_and_context(self):
        text = "Last week spend increased to $48,213, a 12% increase on the week before."
        for n in noro.extract_numbers(text):
            s, e = n["span"]
            self.assertEqual(text[s:e], n["raw"])
            self.assertIn(n["raw"], n["context"])
            self.assertEqual((n["origin"], n["confirmed"]), ("text", True))
        self.assertEqual([n["id"] for n in noro.extract_numbers(text)], ["n1", "n2"])


class MustNotParse(unittest.TestCase):
    def test_identifiers_and_dates(self):
        for text in MUST_NOT_PARSE:
            with self.subTest(text=text):
                self.assertEqual(noro.extract_numbers(text), [], text)

    def test_mixed_sentence_keeps_only_metrics(self):
        text = "In Q4 2026, PR-03 drove $48.2k (top 3 campaign) on Oct 12, up 12% vs W45."
        self.assertEqual([n["raw"] for n in noro.extract_numbers(text)], ["$48.2k", "12%"])

    def test_heading_number_but_not_claim(self):
        text = "## 3. Spend\n\nSpend was $5,000 across 4 campaigns.\n"
        self.assertEqual([n["raw"] for n in noro.extract_numbers(text)], ["$5,000", "4"])


class Ranges(unittest.TestCase):
    def raws(self, text):
        return [(n["raw"], n["value"], n["kind"]) for n in noro.extract_numbers(text)]

    def test_currency_range_with_dash(self):
        self.assertEqual(self.raws("between $95–$109"),
                         [("$95", 95.0, "currency"), ("$109", 109.0, "currency")])
        self.assertEqual(self.raws("between $95-109"),
                         [("$95", 95.0, "currency"), ("109", 109.0, "currency")])

    def test_suffix_shared_across_range(self):
        self.assertEqual(self.raws("CPA of $40–50k"),
                         [("$40", 40000.0, "currency"), ("50k", 50000.0, "currency")])
        self.assertEqual(self.raws("CTR of 12–15%"),
                         [("12", 12.0, "percent"), ("15%", 15.0, "percent")])

    def test_em_dash_is_not_a_range(self):
        self.assertEqual(self.raws("Mon 16.4 — 12% above"),
                         [("16.4", 16.4, "count"), ("12%", 12.0, "percent")])


class Tolerance(unittest.TestCase):
    def half(self, raw):
        return noro._scan_numbers(raw)[0]["half"]

    def test_half_unit_of_last_digit(self):
        self.assertAlmostEqual(self.half("$48.2k"), 50.0)
        self.assertAlmostEqual(self.half("$48k"), 500.0)
        self.assertAlmostEqual(self.half("39%"), 0.5)
        self.assertAlmostEqual(self.half("39.14%"), 0.005)
        self.assertAlmostEqual(self.half("$1.2M"), 50000.0)
        self.assertAlmostEqual(self.half("1,234"), 0.5)
        self.assertAlmostEqual(self.half("30 bps"), 0.005)


class WordCount(unittest.TestCase):
    def test_markdown_symbols_are_not_words(self):
        self.assertEqual(noro.word_count("## Spend — **up** 12% | $5k"), 4)


if __name__ == "__main__":
    unittest.main()
