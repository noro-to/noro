"""Every non-judge rule must flag its `flag` examples and pass its `pass` examples."""
import glob, os, sys, unittest
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "engine"))
from noro import scan  # noqa: E402


def load_yaml_rules():
    rules = []
    for path in sorted(glob.glob(os.path.join(ROOT, "rules", "*", "*.yaml"))):
        with open(path, encoding="utf-8") as f:
            rules.append(yaml.safe_load(f))
    return rules


class TestRuleExamples(unittest.TestCase):
    def test_examples(self):
        for rule in load_yaml_rules():
            if rule["engine"] == "judge":
                continue
            target = "original" if rule["category"] == "watchout" else "text"
            hits = lambda t: [f for f in scan(t, [rule], target=target) if f["rule"] == rule["id"]]
            for text in rule["examples"].get("flag", []):
                with self.subTest(rule=rule["id"], flag=text[:60]):
                    self.assertTrue(hits(text), f"{rule['id']} should flag: {text!r}")
            for text in rule["examples"].get("pass", []):
                with self.subTest(rule=rule["id"], passes=text[:60]):
                    self.assertFalse(hits(text), f"{rule['id']} should pass: {text!r}")

    def test_day_of_week_gold_has_no_errors(self):
        import json
        with open(os.path.join(ROOT, "engine", "rules.json"), encoding="utf-8") as f:
            rules = json.load(f)["rules"]
        with open(os.path.join(ROOT, "bench", "corpus", "11-day-of-week-dense", "gold.md"), encoding="utf-8") as f:
            gold = f.read()
        errors = [x for x in scan(gold, rules, target="text") if x["severity"] == "error"]
        self.assertEqual(errors, [], errors)


if __name__ == "__main__":
    unittest.main()
