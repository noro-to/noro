"""Minimal stand-in for the engine's load_rules/scan, used only when
engine/noro.py is not importable. Implements the phrase, regex,
count and unless semantics from docs/engine.md and nothing else. Stdlib only.
"""
import json
import re

_APOS = str.maketrans({"’": "'"})
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+|\n+")


def load_rules(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data["rules"] if isinstance(data, dict) else data


def _phrase_regex(phrase):
    words = phrase.translate(_APOS).split()
    return re.compile(r"(?<!\w)" + r"\s+".join(re.escape(w) for w in words) + r"(?!\w)", re.I)


def _sentence(text, start, end):
    lo, hi = 0, len(text)
    for m in _SENTENCE_BREAK.finditer(text):
        if m.end() <= start:
            lo = m.end()
        elif m.start() >= max(end, start + 1):
            hi = m.start()
            break
    return text[lo:hi]


def _finding(rule, match, span):
    return {
        "rule": rule["id"], "name": rule["name"], "category": rule["category"],
        "severity": rule["severity"], "match": match, "span": list(span),
        "message": rule["message"].replace("{match}", match), "fix": rule["fix"],
    }


def _applies(rule, target):
    if rule["engine"] == "judge":
        return False
    if target == "original":
        return rule["category"] == "watchout"
    return rule["category"] != "watchout" and rule["applies_to"] in ("text", "both")


def scan(text, rules, target="text"):
    if isinstance(rules, dict):
        rules = rules["rules"]
    norm = text.translate(_APOS)  # same length, so spans line up with text
    findings = []
    for rule in rules:
        if not _applies(rule, target):
            continue
        eng = rule["engine"]
        if eng == "count":
            c = rule["count"]
            hits = list(re.finditer(c["pattern"], text, re.I))
            if c["per"] == "report":
                over = len(hits) > c["max"]
            else:
                words = max(len(text.split()), 1)
                over = len(hits) * 100.0 / words > c["max"]
            if over:
                m = hits[min(len(hits) - 1, int(c["max"]))]
                findings.append(_finding(rule, m.group(0), m.span()))
            continue
        regexes = ([_phrase_regex(p) for p in rule["phrases"]] if eng == "phrase"
                   else [re.compile(p, re.I) for p in rule["patterns"]])
        unless = re.compile(rule["unless"], re.I) if rule.get("unless") else None
        haystack = norm if eng == "phrase" else text
        for rx in regexes:
            for m in rx.finditer(haystack):
                if unless and unless.search(_sentence(text, m.start(), m.end())):
                    continue
                findings.append(_finding(rule, text[m.start():m.end()], m.span()))
    findings.sort(key=lambda f: (f["span"][0], f["rule"]))
    return findings
