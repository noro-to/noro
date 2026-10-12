"""Tracing rewrite numbers to the ledger, with rounding and kind rules."""
import unittest

from engine_helpers import noro


def entry(id_, raw, confirmed=True):
    n = noro._scan_numbers(raw)[0]
    return {"id": id_, "raw": raw, "value": n["value"], "unit": n["unit"], "kind": n["kind"],
            "confirmed": confirmed}


LEDGER = {"numbers": [
    entry("n1", "$48,213"),
    entry("n2", "39.14%"),
    entry("n3", "+0.3 pp"),
    entry("n4", "-3.1%"),
    entry("n5", "ROAS 4.1"),
    entry("n6", "790 conversions"),
    entry("n7", "€1,204.50"),
    entry("n8", "$1,234,567"),
]}


def traces(text, ledger=LEDGER):
    result = noro.trace(text, ledger)
    return not result["untraced"], result


class Rounding(unittest.TestCase):
    def test_rounded_currency_traces(self):
        for text in ("$48,213", "$48.2k", "$48k", "$48.21k", "$1.2M", "$1.23M", "$1,234,567"):
            with self.subTest(text=text):
                self.assertTrue(traces(text)[0])

    def test_wrong_rounding_does_not_trace(self):
        for text in ("$48.3k", "$49k", "$48,210", "$1.3M", "$48,214"):
            with self.subTest(text=text):
                self.assertFalse(traces(text)[0])

    def test_percent_rounding(self):
        self.assertTrue(traces("CTR 39%")[0])
        self.assertTrue(traces("CTR 39.1%")[0])
        self.assertTrue(traces("CTR 39.14%")[0])
        self.assertFalse(traces("CTR 39.2%")[0])
        self.assertFalse(traces("CTR 40%")[0])

    def test_more_precision_than_source_fails(self):
        ledger = {"numbers": [entry("i1", "$48.2k")]}
        self.assertTrue(traces("$48.2k", ledger)[0])
        self.assertFalse(traces("$48,213", ledger)[0])

    def test_nearest_is_reported(self):
        ok, result = traces("Spend was $48.3k.")
        self.assertFalse(ok)
        miss = result["untraced"][0]
        self.assertEqual(miss["raw"], "$48.3k")
        self.assertEqual(miss["nearest"]["id"], "n1")
        self.assertAlmostEqual(miss["nearest"]["delta"], 87.0)


class Kinds(unittest.TestCase):
    def test_pp_matches_only_pp(self):
        self.assertTrue(traces("CVR +0.3 pp")[0])
        self.assertTrue(traces("CVR up 0.3 percentage points")[0])
        self.assertFalse(traces("CVR up 0.3%")[0])
        self.assertFalse(traces("CTR up 39 pp")[0])

    def test_currency_needs_currency_and_same_unit(self):
        self.assertFalse(traces("CPA $790")[0])               # ledger 790 is a count
        self.assertTrue(traces("790 conversions")[0])
        self.assertTrue(traces("€1,204.50")[0])
        self.assertTrue(traces("€1.2k")[0])
        self.assertFalse(traces("$1,204.50")[0])

    def test_multiplier_and_plain_numbers(self):
        self.assertTrue(traces("ROAS of 4.1")[0])
        self.assertTrue(traces("a 4.1x return")[0])
        self.assertTrue(traces("4.1 ROAS")[0])

    def test_sign(self):
        self.assertTrue(traces("CPA fell 3.1%")[0])
        self.assertTrue(traces("CPA moved -3.1%")[0])
        self.assertFalse(traces("CPA moved +3.1%")[0])

    def test_identifiers_are_not_checked(self):
        self.assertTrue(traces("In Q4 2026 (W45, PR-03) on Oct 12, the top 3 held.")[0])


class Confirmation(unittest.TestCase):
    def test_unconfirmed_entry_is_listed(self):
        ledger = {"numbers": [entry("n1", "$48,213"), entry("i1", "$61", confirmed=False)]}
        ok, result = traces("CPA $61 on $48.2k", ledger)
        self.assertTrue(ok)
        self.assertEqual(result["unconfirmed"], ["i1"])

    def test_confirmed_entry_wins_tie(self):
        ledger = {"numbers": [entry("i1", "$61", confirmed=False), entry("n1", "$61")]}
        self.assertEqual(noro.trace("$61", ledger)["unconfirmed"], [])


class Baseline(unittest.TestCase):
    def test_axis_zero_is_exempt(self):
        self.assertTrue(traces("[chart: bars from $0, CPA by day]")[0])
        self.assertTrue(traces("y-axis starts at 0")[0])

    def test_zero_claim_is_checked(self):
        self.assertFalse(traces("Sunday spend was $0.")[0])


if __name__ == "__main__":
    unittest.main()
