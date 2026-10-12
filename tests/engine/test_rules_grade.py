"""scan (phrase, regex, count, unless, judge, watchouts) and grade scoring."""
import tempfile
import unittest
from pathlib import Path

from engine_helpers import RULES, noro, run, write

ALL = noro.load_rules(RULES)


def ids(findings):
    return [f["rule"] for f in findings]


class LoadRules(unittest.TestCase):
    def test_fixture_loads(self):
        self.assertEqual(len(ALL), 8)
        self.assertEqual({r["engine"] for r in ALL}, {"phrase", "regex", "count", "judge"})

    def test_bare_list_and_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write(tmp, "list.json", '[{"id": "T-x", "engine": "phrase", "phrases": ["x"]}]')
            self.assertEqual(len(noro.load_rules(path)), 1)
            with self.assertRaises(noro.NoroError):
                noro.load_rules(Path(tmp) / "missing.json")


class Scan(unittest.TestCase):
    def test_phrase_is_case_insensitive_and_word_bounded(self):
        found = noro.scan("This Could Potentially help. It may potentiallyx not.", ALL)
        self.assertEqual(ids(found), ["T-hedge-stack"])
        self.assertEqual(found[0]["match"], "Could Potentially")
        self.assertEqual(found[0]["message"], "Hedge stack: 'Could Potentially'")
        self.assertEqual(set(found[0]), {"rule", "name", "category", "severity", "match",
                                         "span", "message", "fix"})

    def test_curly_apostrophe_matches_straight(self):
        text = "It’s worth noting that CPA rose."
        found = noro.scan(text, ALL)
        self.assertEqual(ids(found), ["T-worth-noting"])
        s, e = found[0]["span"]
        self.assertEqual(text[s:e], "It’s worth noting")

    def test_regex(self):
        self.assertEqual(ids(noro.scan("CPA rose [X]% to $61.", ALL)), ["N-placeholder"])
        self.assertEqual(ids(noro.scan("CPA rose XX% to $61.", ALL)), ["N-placeholder"])

    def test_unless_drops_finding_in_same_sentence_only(self):
        self.assertEqual(ids(noro.scan("We will continue to monitor and decide by Friday.", ALL)), [])
        text = "We will continue to monitor. We decide by Friday."
        self.assertEqual(ids(noro.scan(text, ALL)), ["A-monitor-no-date"])
        self.assertEqual(ids(noro.scan("A significant increase in leads, up 18%.", ALL)), [])
        self.assertEqual(ids(noro.scan("A significant increase in leads.", ALL)), ["P-vague-change"])

    def test_count_per_report(self):
        self.assertEqual(noro.scan("Spend rose — sharply.", ALL), [])
        text = "Spend rose — sharply — again — today."
        found = noro.scan(text, ALL)
        self.assertEqual(ids(found), ["S-em-dash-count"])
        self.assertEqual(found[0]["message"], "3 em dashes (max 1)")
        self.assertEqual(found[0]["span"][0], text.index("—", text.index("—") + 1))

    def test_count_per_100_words(self):
        rule = {"id": "T-so", "name": "So", "category": "tells", "severity": "warning",
                "engine": "count", "applies_to": "text",
                "count": {"pattern": r"\bso\b", "max": 2, "per": "100 words"}}
        filler = " ".join(["word"] * 96)
        self.assertEqual(noro.scan("so so " + filler, [rule]), [])            # 2 in 98 words
        self.assertEqual(ids(noro.scan("so so so " + filler, [rule])), ["T-so"])
        self.assertEqual(ids(noro.scan("so so so", [rule])), ["T-so"])
        self.assertEqual(noro.scan("so", [rule]), [])                         # short text: max 2
        long_text = "so so so " + " ".join(["word"] * 197)                   # 200 words: max 4
        self.assertEqual(noro.scan(long_text, [rule]), [])

    def test_judge_and_watchouts_are_kept_apart(self):
        text = "PMax drove 40% of conversions."
        self.assertEqual(noro.scan(text, ALL, target="text"), [])
        self.assertEqual(ids(noro.scan(text, ALL, target="original")), ["W-pmax-brand"])
        self.assertEqual(noro.scan("It's worth noting.", ALL, target="original"), [])
        with self.assertRaises(ValueError):
            noro.scan(text, ALL, target="visual")

    def test_sentence_split_ignores_decimals_and_vs(self):
        text = "We will continue to monitor $4.10 vs. by Friday."
        self.assertEqual(noro.scan(text, ALL), [])


class Grade(unittest.TestCase):
    def test_scoring_and_tighten(self):
        text = ("This could potentially indicate a shift. It may potentially recover. "
                "It may potentially not. It's worth noting that CPA rose. "
                "We saw a significant increase in leads. Spend — again — rose.")
        g = noro.grade_text(text, ALL)
        # tells: hedge x3 capped at 2, worth-noting 1 -> 4-3 = 1; shape 3; specificity 3
        self.assertEqual(g["dims"], {"tells": 1, "numbers": 4, "shape": 3, "specificity": 3,
                                     "actions": 4})
        self.assertEqual((g["score"], g["verdict"], g["na"]), (75, "tighten", []))
        self.assertEqual(g["judge_rules"], ["V-chart-title-point"])
        self.assertEqual(g["watchouts"], [])

    def test_clean_report_ships(self):
        g = noro.grade_text("CPA rose 39% to $61 on 790 conversions. Pause brand by Friday.", ALL)
        self.assertEqual((g["score"], g["verdict"], g["findings"]), (100, "ship", []))

    def test_any_error_means_rewrite(self):
        g = noro.grade_text("CPA rose [X]% to $61.", ALL)
        self.assertEqual(g["dims"]["numbers"], 2)                 # error 4, capped at 2 per rule
        self.assertEqual((g["score"], g["verdict"]), (90, "rewrite"))

    def test_low_score_means_rewrite(self):
        text = ("It could potentially work. It's worth noting this. We will continue to monitor. "
                "Keep an eye on it. A notable decline. A substantial lift. A — B — C — D.")
        g = noro.grade_text(text, ALL)
        self.assertLess(g["score"], 85)
        rules = [r for r in ALL if r["category"] == "tells"]
        g2 = noro.grade_text("It could potentially work. It may potentially fail. "
                             "It's worth noting this. It is important to note that.", rules)
        self.assertEqual(g2["na"], ["numbers", "shape", "specificity", "actions"])
        self.assertEqual(g2["dims"]["tells"], 0)
        self.assertEqual((g2["score"], g2["verdict"]), (0, "rewrite"))

    def test_cli_with_watchouts(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = write(tmp, "r.md", "PMax drove 40% of conversions at $61.\n")
            code, g, _ = run("grade", report, "--rules", RULES, "--watchouts")
            self.assertEqual(code, 0)
            self.assertEqual(ids(g["watchouts"]), ["W-pmax-brand"])
            self.assertEqual(set(g), {"score", "verdict", "dims", "na", "findings", "watchouts",
                                      "judge_rules"})
            code, g, _ = run("grade", report, "--rules", RULES)
            self.assertEqual(g["watchouts"], [])


if __name__ == "__main__":
    unittest.main()
