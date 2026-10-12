"""derive math, ledger-add and confirm through the CLI and the API."""
import json
import tempfile
import unittest
from pathlib import Path

from engine_helpers import noro, run, write

REPORT = ("Spend increased to $48,213 from $43,047. CTR moved from 2.4% to 2.7%. "
          "Brand drove 120 conversions and generic 280 conversions.\n")


class DeriveCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.report = write(self.dir, "report.md", REPORT)
        self.ledger = self.dir / "ledger.json"
        code, data, _ = run("extract", self.report, "--out", self.ledger)
        self.assertEqual(code, 0)
        self.assertEqual([n["raw"] for n in data["numbers"]],
                         ["$48,213", "$43,047", "2.4%", "2.7%", "120", "280"])

    def tearDown(self):
        self.tmp.cleanup()

    def derive(self, op, ids):
        return run("derive", "--ledger", self.ledger, "--op", op, "--ids", ids)

    def test_pct_change_matches_spec_example(self):
        code, d, _ = self.derive("pct_change", "n2,n1")
        self.assertEqual(code, 0)
        self.assertEqual(d["id"], "d1")
        self.assertEqual(d["formula"], "(48213-43047)/43047*100")
        self.assertAlmostEqual(d["value"], (48213 - 43047) / 43047 * 100, places=5)
        self.assertEqual((d["kind"], d["unit"], d["derived"], d["confirmed"]),
                         ("percent", "%", True, False))
        self.assertEqual(d["inputs"], ["n2", "n1"])
        saved = json.loads(self.ledger.read_text())
        self.assertEqual(saved["numbers"][-1]["id"], "d1")

    def test_diff_of_percents_is_pp(self):
        _, d, _ = self.derive("diff", "n3,n4")
        self.assertEqual((d["kind"], d["unit"]), ("pp", "pp"))
        self.assertAlmostEqual(d["value"], 0.3)

    def test_diff_of_currency_stays_currency(self):
        _, d, _ = self.derive("diff", "n2,n1")
        self.assertEqual((d["kind"], d["unit"], d["value"]), ("currency", "USD", 5166.0))
        self.assertEqual(d["raw"], "$5,166")

    def test_ratio_sum_share(self):
        _, r, _ = self.derive("ratio", "n1,n2")
        self.assertEqual(r["kind"], "ratio")
        self.assertAlmostEqual(r["value"], 48213 / 43047, places=5)
        _, s, _ = self.derive("sum", "n5,n6")
        self.assertEqual((s["value"], s["kind"], s["formula"]), (400.0, "count", "120+280"))
        _, sh, _ = self.derive("share", "n5,d2")
        self.assertEqual((sh["id"], sh["kind"], sh["value"]), ("d3", "percent", 30.0))

    def test_errors_exit_1(self):
        self.assertEqual(self.derive("pct_change", "n1,n99")[0], 1)
        self.assertEqual(self.derive("pct_change", "n1,n3")[0], 1)       # currency vs percent
        self.assertEqual(self.derive("pct_change", "n1")[0], 1)
        self.assertEqual(self.derive("median", "n1,n2")[0], 1)
        zero = write(self.dir, "zero.md", "Spend went from $0 to $5,000 in a week.\n")
        zl = self.dir / "zero.json"
        run("extract", zero, "--out", zl)
        self.assertEqual(run("derive", "--ledger", zl, "--op", "pct_change", "--ids", "n1,n2")[0], 1)

    def test_ledger_add_and_confirm(self):
        code, i, _ = run("ledger-add", "--ledger", self.ledger, "--raw", "$61.40",
                         "--context", "CPA tile, top-right")
        self.assertEqual(code, 0)
        self.assertEqual((i["id"], i["value"], i["kind"], i["origin"], i["confirmed"]),
                         ("i1", 61.4, "currency", "image", False))
        self.assertEqual(run("ledger-add", "--ledger", self.ledger, "--raw", "Q4")[0], 1)
        code, c, _ = run("confirm", "--ledger", self.ledger, "--ids", "i1")
        self.assertEqual((code, c["confirmed"]), (0, ["i1"]))
        saved = {n["id"]: n for n in json.loads(self.ledger.read_text())["numbers"]}
        self.assertTrue(saved["i1"]["confirmed"])
        self.assertEqual(run("confirm", "--ledger", self.ledger, "--ids", "zz9")[0], 1)

    def test_ledger_add_creates_missing_ledger(self):
        fresh = self.dir / "image-only.json"
        code, i, _ = run("ledger-add", "--ledger", fresh, "--raw", "4.1x", "--context", "ROAS tile")
        self.assertEqual((code, i["id"], i["kind"]), (0, "i1", "multiplier"))
        self.assertTrue(fresh.exists())


class DeriveAPI(unittest.TestCase):
    def test_derived_number_traces_after_confirm(self):
        ledger = {"numbers": noro.extract_numbers("Spend went from $43,047 to $48,213.")}
        d = noro.derive_number(ledger, "pct_change", ["n1", "n2"], label="Spend change")
        self.assertEqual(d["raw"], "12.0%")
        result = noro.trace("Spend rose 12%.", ledger)
        self.assertEqual((result["untraced"], result["unconfirmed"]), ([], ["d1"]))
        d["confirmed"] = True
        self.assertEqual(noro.trace("Spend rose 12.0%.", ledger)["unconfirmed"], [])


if __name__ == "__main__":
    unittest.main()
