#!/usr/bin/env python3
"""Build engine/rules.json from rules/**/*.yaml.

Usage:
  python3 tools/build_rules.py            # validate and write rules.json
  python3 tools/build_rules.py --check    # validate; exit 1 if rules.json is stale

PyYAML is a dev-only dependency. The engine reads only the JSON this writes.
Exit codes: 0 ok, 1 validation error or stale output.
"""
import argparse
import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("build_rules: PyYAML is required (pip install pyyaml)")

ROOT = Path(__file__).resolve().parent.parent
RULES_DIR = ROOT / "rules"
OUT = ROOT / "engine" / "rules.json"
VERSION = "0.1.0"

PREFIX = {"tells": "T", "numbers": "N", "shape": "S", "specificity": "P",
          "actions": "A", "visual": "V", "watchout": "W"}
SEVERITIES = {"error", "warning", "advisory"}
ENGINES = {"phrase", "regex", "count", "judge"}
APPLIES = {"text", "visual", "both"}
PER = {"report", "100 words"}
REQUIRED = ["id", "slug", "name", "category", "severity", "engine", "applies_to",
            "message", "why", "fix", "examples", "source"]
ENGINE_FIELD = {"phrase": "phrases", "regex": "patterns", "count": "count", "judge": "rubric"}
OPTIONAL = ["phrases", "patterns", "unless", "count", "rubric"]
ORDER = REQUIRED[:7] + OPTIONAL + REQUIRED[7:]
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _compile(pattern, where, errors):
    if not isinstance(pattern, str) or not pattern:
        errors.append(f"{where}: must be a non-empty string")
        return
    try:
        re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        errors.append(f"{where}: regex does not compile: {exc}")


def _strings(value, where, errors):
    if not isinstance(value, list) or not value:
        errors.append(f"{where}: must be a non-empty list")
        return []
    bad = [v for v in value if not isinstance(v, str) or not v.strip()]
    if bad:
        errors.append(f"{where}: every item must be a non-empty string")
    return [v for v in value if isinstance(v, str)]


def validate(rule, path, errors):
    where = str(path.relative_to(ROOT))
    if not isinstance(rule, dict):
        errors.append(f"{where}: top level must be a mapping")
        return None
    for key in REQUIRED:
        if key not in rule or rule[key] in (None, "", [], {}):
            errors.append(f"{where}: missing required field '{key}'")
    for key in rule:
        if key not in REQUIRED and key not in OPTIONAL:
            errors.append(f"{where}: unknown field '{key}'")
    if any(k not in rule for k in REQUIRED):
        return None

    cat, eng, slug = rule["category"], rule["engine"], rule["slug"]
    if cat not in PREFIX:
        errors.append(f"{where}: category '{cat}' not one of {sorted(PREFIX)}")
        return None
    if path.parent.name != cat:
        errors.append(f"{where}: file is in rules/{path.parent.name}/ but category is '{cat}'")
    if not SLUG_RE.match(str(slug)):
        errors.append(f"{where}: slug '{slug}' must be lowercase words joined by hyphens")
    if path.stem != slug:
        errors.append(f"{where}: file name must be <slug>.yaml ('{slug}.yaml')")
    if rule["id"] != f"{PREFIX[cat]}-{slug}":
        errors.append(f"{where}: id must be '{PREFIX[cat]}-{slug}' (prefix by category, then slug)")
    if rule["severity"] not in SEVERITIES:
        errors.append(f"{where}: severity '{rule['severity']}' not one of {sorted(SEVERITIES)}")
    if eng not in ENGINES:
        errors.append(f"{where}: engine '{eng}' not one of {sorted(ENGINES)}")
        return None
    if rule["applies_to"] not in APPLIES:
        errors.append(f"{where}: applies_to '{rule['applies_to']}' not one of {sorted(APPLIES)}")
    for key in ("name", "message", "why", "fix", "source"):
        if not isinstance(rule[key], str):
            errors.append(f"{where}: '{key}' must be a string")

    # Category constraints.
    if cat == "visual" and (eng != "judge" or rule["applies_to"] != "visual"):
        errors.append(f"{where}: visual rules use engine judge and applies_to visual")
    if eng == "judge" and cat not in ("visual", "shape", "actions"):
        errors.append(f"{where}: only visual, shape and actions rules may use engine judge")
    if cat == "watchout" and rule["severity"] != "advisory":
        errors.append(f"{where}: watchouts are advisory")

    # Engine fields: the one the engine needs must be there; the others must not.
    need = ENGINE_FIELD[eng]
    if need not in rule:
        errors.append(f"{where}: engine '{eng}' needs '{need}'")
    for other_engine, field in ENGINE_FIELD.items():
        if other_engine != eng and field in rule:
            errors.append(f"{where}: '{field}' is only for engine '{other_engine}'")

    if eng == "phrase" and "phrases" in rule:
        for i, p in enumerate(_strings(rule["phrases"], f"{where}: phrases", errors)):
            if not (p[0].isalnum() and p[-1].isalnum()):
                errors.append(f"{where}: phrases[{i}] '{p}' must start and end with a letter "
                              "or digit (word boundaries); use engine regex instead")
    if eng == "regex" and "patterns" in rule:
        for i, p in enumerate(_strings(rule["patterns"], f"{where}: patterns", errors)):
            _compile(p, f"{where}: patterns[{i}]", errors)
    if eng == "count" and "count" in rule:
        c = rule["count"]
        if not isinstance(c, dict) or set(c) != {"pattern", "max", "per"}:
            errors.append(f"{where}: count needs exactly pattern, max, per")
        else:
            _compile(c["pattern"], f"{where}: count.pattern", errors)
            if isinstance(c["max"], bool) or not isinstance(c["max"], (int, float)) or c["max"] < 0:
                errors.append(f"{where}: count.max must be a number >= 0")
            if c["per"] not in PER:
                errors.append(f"{where}: count.per must be one of {sorted(PER)}")
    if eng == "judge" and "rubric" in rule:
        r = rule["rubric"]
        anchors = r.get("anchors") if isinstance(r, dict) else None
        if not isinstance(r, dict) or not isinstance(r.get("question"), str) or not r["question"].strip():
            errors.append(f"{where}: rubric needs a question")
        if not isinstance(anchors, dict) or {str(k) for k in anchors} != {"0", "1", "2"} \
                or not all(isinstance(v, str) and v.strip() for v in anchors.values()):
            errors.append(f"{where}: rubric.anchors needs non-empty 0, 1 and 2")
        else:
            rule["rubric"] = {"question": r["question"],
                              "anchors": {str(k): anchors[k] for k in sorted(anchors, key=str)}}
    if "unless" in rule:
        if eng not in ("phrase", "regex"):
            errors.append(f"{where}: unless only applies to phrase and regex rules")
        _compile(rule["unless"], f"{where}: unless", errors)

    ex = rule["examples"]
    if not isinstance(ex, dict) or set(ex) != {"flag", "pass"}:
        errors.append(f"{where}: examples needs exactly 'flag' and 'pass' lists")
    else:
        _strings(ex["flag"], f"{where}: examples.flag", errors)
        _strings(ex["pass"], f"{where}: examples.pass", errors)

    return {k: rule[k] for k in ORDER if k in rule}


def build():
    errors, rules, ids, slugs = [], [], {}, {}
    files = sorted(RULES_DIR.glob("**/*.yaml")) + sorted(RULES_DIR.glob("**/*.yml"))
    if not files:
        errors.append(f"no rule files under {RULES_DIR}")
    for path in files:
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            errors.append(f"{path.relative_to(ROOT)}: YAML error: {exc}")
            continue
        rule = validate(data, path, errors)
        if rule is None:
            continue
        for key, seen in (("id", ids), ("slug", slugs)):
            if rule[key] in seen:
                errors.append(f"{path.relative_to(ROOT)}: duplicate {key} '{rule[key]}' "
                              f"(also in {seen[rule[key]]})")
            seen[rule[key]] = str(path.relative_to(ROOT))
        rules.append(rule)
    rules.sort(key=lambda r: r["id"])
    text = json.dumps({"version": VERSION, "rules": rules}, indent=2, ensure_ascii=False) + "\n"
    return text, rules, errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="fail if rules.json is out of date")
    ap.add_argument("--out", default=str(OUT), help="output path (default: %(default)s)")
    args = ap.parse_args(argv)

    text, rules, errors = build()
    if errors:
        for e in errors:
            print(f"error: {e}", file=sys.stderr)
        print(f"build_rules: {len(errors)} error(s); nothing written", file=sys.stderr)
        return 1
    out = Path(args.out)
    if args.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current != text:
            print(f"build_rules: {out} is stale; run python3 tools/build_rules.py", file=sys.stderr)
            return 1
        print(f"build_rules: {len(rules)} rules, {out} is up to date")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    counts = {}
    for r in rules:
        counts[r["category"]] = counts.get(r["category"], 0) + 1
    summary = ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
    print(f"build_rules: wrote {len(rules)} rules to {out} ({summary})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
