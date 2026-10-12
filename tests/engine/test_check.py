"""check: the gate a rewrite must pass. Includes the real corpus case."""
import tempfile
import unittest
from pathlib import Path

from engine_helpers import FIXTURES, RULES, run, write

ORIGINAL = (
    "## Weekly performance\n\n"
    "It is important to note that spend increased to $48,213 this week, compared with "
    "$43,047 the week before. Cost per acquisition moved to $61.40 across 790 conversions, "
    "and the conversion rate held at 2.7%. Return on ad spend came in at ROAS 4.1 for the "
    "brand campaigns, which is broadly in line with what we have seen over recent weeks.\n"
)


class CheckCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.original = write(self.dir, "original.md", ORIGINAL)
        self.ledger = self.dir / "ledger.json"
        self.assertEqual(run("extract", self.original, "--out", self.ledger)[0], 0)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, text, name="rewrite.md"):
        rewrite = write(self.dir, name, text)
        return run("check", rewrite, "--ledger", self.ledger, "--original", self.original,
                   "--rules", RULES)

    def test_pass(self):
        code, data, _ = self.check("Spend: $48.2k. CPA: $61 on 790 conversions. ROAS 4.1x.\n")
        self.assertEqual((code, data["pass"], data["exit"]), (0, True, 0))
        self.assertEqual(data["untraced"], [])
        self.assertTrue(data["length"]["shorter"])
        self.assertEqual(data["length"]["original_words"], 62)            # "##" is not a word

    def test_untraced_number_fails(self):
        code, data, _ = self.check("Spend: $48.2k. CPA: $59 on 790 conversions.\n")
        self.assertEqual((code, data["pass"], data["exit"]), (2, False, 2))
        self.assertEqual([u["raw"] for u in data["untraced"]], ["$59"])
        self.assertEqual(data["untraced"][0]["nearest"]["raw"], "$61.40")

    def test_longer_rewrite_fails(self):
        code, data, _ = self.check(ORIGINAL + "\nOne more sentence here.\n")
        self.assertEqual(code, 2)
        self.assertFalse(data["length"]["shorter"])
        self.assertEqual(data["untraced"], [])

    def test_error_tell_fails_but_warning_does_not(self):
        code, data, _ = self.check("CPA rose [X]% to $61.40.\n")
        self.assertEqual(code, 2)
        self.assertEqual([t["rule"] for t in data["tells"]], ["N-placeholder"])
        code, data, _ = self.check("It’s worth noting CPA is $61.40.\n")
        self.assertEqual((code, data["tells"][0]["rule"]), (0, "T-worth-noting"))

    def test_unconfirmed_derived_number_fails_until_confirmed(self):
        code, d, _ = run("derive", "--ledger", self.ledger, "--op", "pct_change", "--ids", "n2,n1")
        self.assertEqual(code, 0)
        text = "Spend rose 12% to $48.2k.\n"
        code, data, _ = self.check(text)
        self.assertEqual((code, data["unconfirmed"]), (2, [d["id"]]))
        run("confirm", "--ledger", self.ledger, "--ids", d["id"])
        code, data, _ = self.check(text)
        self.assertEqual((code, data["pass"]), (0, True))

    def test_image_number_needs_confirmation(self):
        run("ledger-add", "--ledger", self.ledger, "--raw", "$3,120", "--context", "Revenue tile")
        code, data, _ = self.check("Revenue: $3.1k.\n")
        self.assertEqual((code, data["unconfirmed"]), (2, ["i1"]))

    def test_input_errors_exit_1(self):
        code, data, _ = run("check", self.original)                     # missing flags
        self.assertEqual(code, 1)
        self.assertIn("error", data)
        pdf = write(self.dir, "report.pdf", "x")
        self.assertEqual(run("extract", pdf)[0], 1)
        self.assertEqual(run("extract", self.dir / "missing.md")[0], 1)
        rewrite = write(self.dir, "r.md", "Spend $48.2k.\n")
        self.assertEqual(run("check", rewrite, "--ledger", self.dir / "none.json",
                             "--original", self.original, "--rules", RULES)[0], 1)
        self.assertEqual(run("check", rewrite, "--ledger", self.ledger, "--original",
                             self.original, "--rules", self.dir / "no-rules.json")[0], 1)
        self.assertEqual(run()[0], 1)


class CorpusDayOfWeek(unittest.TestCase):
    """bench/corpus/11-day-of-week-dense: every gold number traces and the gold is shorter."""

    def test_gold_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.json"
            code, extracted, _ = run("extract", FIXTURES / "original.md", "--out", ledger)
            self.assertEqual(code, 0)
            raws = [n["raw"] for n in extracted["numbers"]]
            for expected in ("$95", "$109", "$138", "$101", "$127", "16.4", "9.6", "9.8%",
                             "14.1%", "$13.52", "22%"):
                self.assertIn(expected, raws)
            self.assertNotIn("2026", raws)
            code, data, _ = run("check", FIXTURES / "gold.md", "--ledger", ledger,
                                "--original", FIXTURES / "original.md", "--rules", RULES)
            self.assertEqual(data["untraced"], [], data["untraced"])
            self.assertEqual(data["unconfirmed"], [])
            self.assertTrue(data["length"]["shorter"])
            self.assertEqual((code, data["pass"]), (0, True))
            self.assertIn("$13.52", [t["raw"] for t in data["traced"]])

    def test_original_does_not_pass_as_its_own_rewrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.json"
            run("extract", FIXTURES / "original.md", "--out", ledger)
            code, data, _ = run("check", FIXTURES / "original.md", "--ledger", ledger,
                                "--original", FIXTURES / "original.md", "--rules", RULES)
            self.assertEqual((code, data["untraced"], data["length"]["shorter"]), (2, [], False))


if __name__ == "__main__":
    unittest.main()
