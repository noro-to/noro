#!/usr/bin/env python3
"""noro engine: number ledger, number tracing and slop rules for report rewrites.

Every command prints JSON to stdout. Exit codes: 0 ok/pass, 2 check failed,
1 usage or input error. Python 3.9+, standard library only.

    noro.py extract REPORT [--out LEDGER]
    noro.py ledger-add --ledger LEDGER --raw "$48.2k" --context TEXT [--source image]
    noro.py derive --ledger LEDGER --op pct_change|diff|ratio|sum|share --ids n2,n1 [--label TEXT]
    noro.py confirm --ledger LEDGER --ids d1,i3
    noro.py check REWRITE --ledger LEDGER --original REPORT [--rules RULES]
    noro.py grade REPORT [--rules RULES] [--watchouts]

Python API: load_rules, scan, extract_numbers, trace, derive_number, grade_text, word_count.
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import re
import sys
from pathlib import Path

VERSION = "0.1.0"
DEFAULT_RULES = Path(__file__).resolve().with_name("rules.json")
TEXT_SUFFIXES = {".txt", ".md", ".markdown"}


class NoroError(Exception):
    """An input or usage problem; the CLI reports it as {"error": ...} with exit code 1."""


# --------------------------------------------------------------------------- numbers

CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP"}
SYMBOL_FOR_UNIT = {unit: sym for sym, unit in CURRENCY_SYMBOLS.items()}
SCALES = {"k": 1e3, "thousand": 1e3, "m": 1e6, "mm": 1e6, "mn": 1e6, "million": 1e6,
          "b": 1e9, "bn": 1e9, "billion": 1e9}
UNIT_FOR_KIND = {"percent": "%", "pp": "pp", "multiplier": "x", "ratio": "x", "count": ""}
# Kinds that may stand in for each other when tracing. Currency also needs the same unit.
KIND_GROUP = {"currency": "currency", "percent": "percent", "pp": "pp",
              "count": "plain", "multiplier": "plain", "ratio": "plain"}

NUMBER_RE = re.compile(r"""
    (?P<sign>[+\-−])?
    (?:(?P<sym>[$€£])|(?P<code>(?:USD|EUR|GBP|CAD|AUD)\s?))?
    (?P<sign2>[+\-−])?
    (?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)
    (?P<scale>(?:[kK]|MM|mm|[Mm]n|[Mm]|[Bb]n|B)(?![A-Za-z0-9])
             |\s?(?:thousand|million|billion)\b)?
    (?P<tail>%\s?(?:points?|pts?)\b
            |\s?(?:pp|ppts?|percentage[ -]points?|pts?|points?|bps|basis\ points?)(?![A-Za-z])
            |\s?%
            |\s(?:percent|per\ cent)\b
            |[xX×](?![A-Za-z0-9]))?
    (?P<code2>\s(?:USD|EUR|GBP|CAD|AUD)\b)?
""", re.X)

_MONTH = (r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?"
          r"|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)")
_NOT_METRIC = r"(?![.,]\d|\s?(?:%|percent|pp\b|pts?\b|points?\b|x\b|[kKMB]\b))"
# Regions that hold digits but never a performance number: URLs, dates, times,
# footnotes, markdown heading numbers and list markers.
_MASKS = [
    re.compile(r"https?://\S+|www\.\S+"),
    re.compile(r"\b\d{4}-\d{1,2}(?:-\d{1,2})?\b"),
    re.compile(r"\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b"),
    re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?"),
    re.compile(r"\b\d{1,2}\s?(?:am|pm|AM|PM|a\.m\.|p\.m\.)(?![A-Za-z])"),
    re.compile(rf"\b{_MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:\s?[-–]\s?\d{{1,2}}(?:st|nd|rd|th)?)?"
               rf"\b{_NOT_METRIC}(?:,?\s+\d{{4}}\b)?"),
    re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)?(?:\s?[-–]\s?\d{{1,2}}(?:st|nd|rd|th)?)?\s+{_MONTH}\b"),
    re.compile(r"\[\d+\]"),
    re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+\d+(?:\.\d+)*[.)]?(?=\s)", re.M),
    re.compile(r"^[ \t]*\d+[.)](?=\s)", re.M),
]
# A bare integer right after one of these words is a label or rank, not a metric.
LABEL_BEFORE_RE = re.compile(
    r"(?i)\b(?:top|bottom|rank(?:ed)?|no\.|number|step|phase|part|section|page|slide|chapter"
    r"|item|tier|level|round|wave|week|wk|quarter|version|ver\.|figure|fig\.|table|row|column"
    r"|col\.|option|group|cohort|variant|batch|sprint)\s*#?\s*$")
METRIC_AFTER_RE = re.compile(
    r"\s+(?:clicks|conversions|impressions|orders|sales|leads|sessions|visits|visitors|users"
    r"|calls|units|purchases|sign-?ups|installs|views|transactions|customers|bookings"
    r"|downloads|subscribers|followers)\b", re.I)
ROAS_BEFORE_RE = re.compile(r"\b(?:i?ROAS|ROI|MER|return on ad spend)\b[^\d$€£%;\n]{0,25}$", re.I)
ROAS_AFTER_RE = re.compile(r"\s?(?:i?ROAS|ROI|MER)\b", re.I)
RANGE_JOIN_RE = re.compile(r"[-–]|\s+to\s+")
BASELINE_RE = re.compile(r"(?i)\b(?:from|axis|baseline|zero|start(?:s|ing)?\s+at)\W*$")


def _masked_spans(text):
    return [m.span() for rx in _MASKS for m in rx.finditer(text)]


def _token(text, m, masked):
    """Turn one regex match into a raw token dict, or None if it is an identifier."""
    start, end = m.span()
    sign = m.group("sign")
    prev = text[start - 1] if start else " "
    if sign:
        if prev.isalpha() or prev == "_":           # PR-03, W-45, SKU-1234
            return None
        if prev.isdigit() or prev in "%.,)":        # a range such as 95-109: the dash joins
            sign, start = None, start + 1
            prev = text[start - 1]
    sign = sign or m.group("sign2")
    if any(a < end and start < b for a, b in masked):
        return None
    if prev.isalnum() or prev in "_#'’":      # Q4, v1.2, #3, '26
        return None
    if prev in "./:" and start >= 2 and text[start - 2].isdigit():
        return None
    nxt = text[end] if end < len(text) else " "
    if nxt.isalnum() or nxt == "_":                 # 3rd, 5G, 2x2
        return None
    if nxt in ".:/," and end + 1 < len(text) and text[end + 1].isdigit():
        return None                                 # 1.2.3, 12,5
    num, scale, tail = m.group("num"), m.group("scale"), m.group("tail")
    cur = CURRENCY_SYMBOLS.get(m.group("sym") or "") or \
        (m.group("code") or m.group("code2") or "").strip() or None
    if not (cur or scale or tail or sign) and "." not in num and "," not in num:
        if LABEL_BEFORE_RE.search(text[max(0, start - 24):start]):
            return None                             # top 3, step 2
        if len(num) == 4 and 1900 <= int(num) <= 2099 and not METRIC_AFTER_RE.match(text, end):
            return None                             # a year
    roas = not (cur or tail) and bool(
        ROAS_BEFORE_RE.search(text[max(0, start - 40):start]) or ROAS_AFTER_RE.match(text, end))
    return {"s": start, "e": end, "sign": sign, "cur": cur, "num": num,
            "scale": scale, "tail": tail, "roas": roas}


def _inherit_ranges(text, toks):
    """In '$95-109', '12-15%' and '$40-50k' both ends share the unit and scale."""
    for a, b in zip(toks, toks[1:]):
        if not RANGE_JOIN_RE.fullmatch(text[a["e"]:b["s"]]):
            continue
        if b["tail"] and not (a["tail"] or a["cur"]):
            a["tail"] = b["tail"]
        if b["scale"] and not (a["scale"] or a["tail"]):
            a["scale"] = b["scale"]
        if a["cur"] and not (b["cur"] or b["tail"]):
            b["cur"] = a["cur"]


def _finish(text, t):
    """Compute kind, unit, value and tracing tolerance for a raw token."""
    digits = t["num"].replace(",", "")
    step = 10.0 ** -len(digits.partition(".")[2])
    value = float(digits)
    scale = SCALES.get((t["scale"] or "").strip().lower(), 1.0)
    tail = re.sub(r"[\s-]+", "", (t["tail"] or "").lower())
    if tail.startswith("%") and len(tail) > 1:
        kind = "pp"                                 # "% points"
    elif tail in ("%", "percent"):
        kind = "percent"
    elif tail in ("x", "×"):
        kind = "multiplier"
    elif tail.startswith(("bps", "basis")):
        kind, scale = "pp", 0.01
    elif tail:
        kind = "pp"
    elif t["cur"]:
        kind = "currency"
    elif t["roas"]:
        kind = "multiplier"
    else:
        kind = "count"
    if t["sign"] in ("-", "−"):
        value = -value
    return {"raw": text[t["s"]:t["e"]], "value": round(value * scale, 9),
            "unit": t["cur"] if kind == "currency" else UNIT_FOR_KIND[kind], "kind": kind,
            "span": [t["s"], t["e"]], "signed": bool(t["sign"]), "half": step * scale / 2}


def _scan_numbers(text):
    masked = _masked_spans(text)
    toks = [t for t in (_token(text, m, masked) for m in NUMBER_RE.finditer(text)) if t]
    _inherit_ranges(text, toks)
    return [_finish(text, t) for t in toks]


def _context(text, s, e, width=40):
    a, b = max(0, s - width), min(len(text), e + width)
    return ("..." if a else "") + " ".join(text[a:b].split()) + ("..." if b < len(text) else "")


def extract_numbers(text):
    """Return every metric number in `text` as ledger entries (n1, n2, ...)."""
    out = []
    for i, t in enumerate(_scan_numbers(text), 1):
        s, e = t["span"]
        out.append({"id": f"n{i}", "raw": t["raw"], "value": t["value"], "unit": t["unit"],
                    "kind": t["kind"], "context": _context(text, s, e), "span": [s, e],
                    "origin": "text", "confirmed": True})
    return out


def word_count(text):
    """Words are whitespace-separated tokens holding at least one letter or digit."""
    return sum(1 for w in text.split() if re.search(r"\w", w))


# --------------------------------------------------------------------------- tracing

def _compatible(a, b):
    ga, gb = KIND_GROUP.get(a.get("kind")), KIND_GROUP.get(b.get("kind"))
    return ga is not None and ga == gb and (ga != "currency" or a.get("unit") == b.get("unit"))


def _delta(tok, entry):
    a, b = tok["value"], float(entry["value"])
    if not tok["signed"]:                           # "fell 3.1%" may cite a ledger -3.1%
        a, b = abs(a), abs(b)
    return a - b


def _entries(ledger):
    return ledger.get("numbers", []) if isinstance(ledger, dict) else list(ledger)


def trace(rewrite_text, ledger):
    """Match every number in a rewrite to the ledger.

    A number traces when a ledger entry of a compatible kind lies within half a unit
    of the rewrite's last shown digit. Confirmed entries win ties. Returns
    {"traced": [...], "untraced": [{raw, value, span, nearest}], "unconfirmed": [ids]}.
    """
    entries = _entries(ledger)
    traced, untraced, unconfirmed = [], [], []
    for tok in _scan_numbers(rewrite_text):
        item = {"raw": tok["raw"], "value": tok["value"], "span": tok["span"]}
        s = tok["span"][0]
        if tok["value"] == 0 and BASELINE_RE.search(rewrite_text[max(0, s - 25):s]):
            traced.append(dict(item, id=None, note="axis baseline"))
            continue
        limit = tok["half"] * (1 + 1e-9) + 1e-12
        hits = [e for e in entries if _compatible(tok, e) and abs(_delta(tok, e)) <= limit]
        if not hits:
            pool = [e for e in entries if _compatible(tok, e)] or entries
            near = min(pool, key=lambda e: abs(_delta(tok, e)), default=None)
            item["nearest"] = None if near is None else {
                "id": near.get("id"), "raw": near.get("raw"), "delta": round(_delta(tok, near), 6)}
            untraced.append(item)
            continue
        hit = min(hits, key=lambda e: (not e.get("confirmed", False), abs(_delta(tok, e))))
        traced.append(dict(item, id=hit.get("id")))
        if not hit.get("confirmed", False) and hit.get("id") not in unconfirmed:
            unconfirmed.append(hit.get("id"))
    return {"traced": traced, "untraced": untraced, "unconfirmed": unconfirmed}


# --------------------------------------------------------------------------- derive

OPS = ("pct_change", "diff", "ratio", "sum", "share")


def _num(v):
    s = f"{v:.10g}"
    return f"({s})" if v < 0 else s


def _display(v, kind, unit):
    if kind == "percent":
        return f"{v:.1f}%"
    if kind == "pp":
        return f"{v:+.1f} pp"
    if kind in ("ratio", "multiplier"):
        return f"{v:.2f}x"
    if kind == "currency":
        body = f"{abs(v):,.0f}" if abs(v) >= 1000 else f"{abs(v):,.2f}"
        sym = SYMBOL_FOR_UNIT.get(unit)
        return ("-" if v < 0 else "") + (sym + body if sym else f"{body} {unit}")
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"


def _next_id(ledger, prefix):
    used = [int(n["id"][len(prefix):]) for n in ledger["numbers"]
            if re.fullmatch(re.escape(prefix) + r"\d+", str(n.get("id", "")))]
    return f"{prefix}{max(used, default=0) + 1}"


def derive_number(ledger, op, ids, label=None):
    """Compute a new number from ledger entries and append it, unconfirmed.

    pct_change from,to = (to - from) / from * 100      diff from,to = to - from
    ratio a,b = a / b                                    share part,whole = part / whole * 100
    sum a,b,... = a + b + ...
    diff of two percents is in percentage points (pp).
    """
    if op not in OPS:
        raise NoroError(f"unknown --op {op!r}; use one of {', '.join(OPS)}")
    by_id = {n.get("id"): n for n in ledger["numbers"]}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise NoroError(f"unknown ledger ids: {', '.join(missing)}")
    xs = [by_id[i] for i in ids]
    vals = [float(x["value"]) for x in xs]
    if op == "sum" and len(xs) < 2 or op != "sum" and len(xs) != 2:
        raise NoroError(f"--op {op} takes {'two or more' if op == 'sum' else 'exactly two'} ids")
    if op != "ratio" and not all(_compatible(xs[0], x) for x in xs[1:]):
        raise NoroError(f"cannot {op} a {xs[0]['kind']} with a {xs[1]['kind']}")
    a, b = vals[0], vals[-1]
    if op in ("pct_change",) and a == 0 or op in ("ratio", "share") and b == 0:
        raise NoroError(f"{op} would divide by zero")
    kind, unit = xs[0]["kind"], xs[0].get("unit", "")
    if op == "pct_change":
        value, kind, unit, formula = (b - a) / a * 100, "percent", "%", f"({_num(b)}-{_num(a)})/{_num(a)}*100"
    elif op == "diff":
        value, formula = b - a, f"{_num(b)}-{_num(a)}"
        if kind in ("percent", "pp"):
            kind, unit = "pp", "pp"
    elif op == "ratio":
        value, kind, unit, formula = a / b, "ratio", "x", f"{_num(a)}/{_num(b)}"
    elif op == "share":
        value, kind, unit, formula = a / b * 100, "percent", "%", f"{_num(a)}/{_num(b)}*100"
    else:
        value, formula = sum(vals), "+".join(_num(v) for v in vals)
    value = round(value, 6)
    entry = {"id": _next_id(ledger, "d"), "raw": _display(value, kind, unit), "value": value,
             "unit": unit, "kind": kind, "formula": formula, "derived": True, "inputs": list(ids),
             "label": label or "", "context": label or f"{op}({', '.join(ids)})", "span": None,
             "origin": "derived", "confirmed": False}
    ledger["numbers"].append(entry)
    return entry


# --------------------------------------------------------------------------- rules

SEVERITY_WEIGHT = {"error": 4, "warning": 1, "advisory": 0}
DIMS = ("tells", "numbers", "shape", "specificity", "actions")
RULE_CAP = 2
_QUOTES = str.maketrans({"’": "'", "‘": "'"})
_SENT_END_RE = re.compile(r"[.!?]+[\"'”’)\]*_]*(?=\s|$)|\n")
_ABBREV_RE = re.compile(r"(?i)(?:^|[^\w.])(?:vs|e\.g|i\.e|approx|fig|cf|est|incl)$")


def load_rules(path):
    """Load rules.json ({"version", "rules": [...]}) or a bare list and return the rules."""
    p = Path(path)
    if not p.is_file():
        raise NoroError(f"rules file not found: {p} (build it with tools/build_rules.py)")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise NoroError(f"rules file is not valid JSON: {p}: {exc}") from None
    rules = data.get("rules") if isinstance(data, dict) else data
    if not isinstance(rules, list):
        raise NoroError(f"rules file has no rule list: {p}")
    return rules


def _runs_on(rule, target):
    """Whether the engine applies `rule` to a report/rewrite ("text") or to the original."""
    if rule.get("engine") not in ("phrase", "regex", "count"):
        return False
    if rule.get("applies_to", "text") not in ("text", "both"):
        return False
    is_watchout = rule.get("category") == "watchout"
    return is_watchout if target == "original" else not is_watchout


def _sentence_spans(text):
    spans, start = [], 0
    for m in _SENT_END_RE.finditer(text):
        if m.group()[0] == "." and _ABBREV_RE.search(text[max(0, m.start() - 8):m.start()]):
            continue                                # "vs." and "e.g." do not end a sentence
        spans.append((start, m.end()))
        start = m.end()
    spans.append((start, len(text)))
    return spans


def _phrase_regex(phrase):
    parts = [re.escape(p) for p in phrase.translate(_QUOTES).split()]
    return re.compile(r"(?<!\w)" + r"\s+".join(parts) + r"(?!\w)", re.I)


def _rule_spans(rule, norm):
    engine = rule["engine"]
    if engine == "phrase":
        rxs = [_phrase_regex(p) for p in rule.get("phrases") or []]
    elif engine == "regex":
        rxs = [re.compile(p, re.I) for p in rule.get("patterns") or []]
    else:
        rxs = [re.compile(rule["count"]["pattern"], re.I)]
    spans = sorted({m.span() for rx in rxs for m in rx.finditer(norm) if m.end() > m.start()},
                   key=lambda sp: (sp[0], -sp[1]))
    kept, last = [], -1
    for s, e in spans:                              # one finding per stretch of text
        if s >= last:
            kept.append((s, e))
            last = e
    return kept


def _finding(rule, text, s, e, extra=None):
    match = text[s:e]
    message = str(rule.get("message") or rule.get("name") or rule["id"]).replace("{match}", match)
    for key, val in (extra or {}).items():
        message = message.replace("{" + key + "}", str(val))
    return {"rule": rule["id"], "name": rule.get("name", rule["id"]),
            "category": rule.get("category"), "severity": rule.get("severity", "warning"),
            "match": match, "span": [s, e], "message": message, "fix": rule.get("fix", "")}


def scan(text, rules, target="text"):
    """Run phrase, regex and count rules over `text` and return findings.

    target="text": a report or rewrite; rules with applies_to text|both, no watchouts.
    target="original": watchout rules only. Judge rules are never run here.
    A rule's `unless` regex drops a finding when it matches the same sentence.
    """
    if target not in ("text", "original"):
        raise ValueError("target must be 'text' or 'original'")
    norm = text.translate(_QUOTES)                  # same length, so spans hold for `text`
    sents = _sentence_spans(norm)
    starts = [s for s, _ in sents]
    findings = []
    for rule in rules:
        if not _runs_on(rule, target):
            continue
        spans = _rule_spans(rule, norm)
        if rule.get("unless"):
            unless = re.compile(rule["unless"], re.I)
            keep = []
            for s, e in spans:
                a, b = sents[max(0, bisect.bisect_right(starts, s) - 1)]
                if not unless.search(norm[a:b]):
                    keep.append((s, e))
            spans = keep
        if rule["engine"] == "count":
            cfg = rule["count"]
            cap = float(cfg.get("max", 0))
            if "100" in str(cfg.get("per", "report")):      # max per started 100 words
                cap = cap * max(1, math.ceil(word_count(norm) / 100))
            if len(spans) <= cap:
                continue
            s, e = spans[min(int(math.floor(cap)), len(spans) - 1)]
            findings.append(_finding(rule, text, s, e, {"count": len(spans), "max": cfg.get("max", 0)}))
        else:
            findings.extend(_finding(rule, text, s, e) for s, e in spans)
    findings.sort(key=lambda f: (f["span"][0], f["rule"]))
    return findings


def _round_half_up(x):
    return int(math.floor(x + 0.5))


def grade_text(text, rules, watchouts=False):
    """Score a report 0-100 on five dimensions and return the grade payload."""
    findings = scan(text, rules, "text")
    applicable = {r.get("category") for r in rules if _runs_on(r, "text")} & set(DIMS)
    per_rule, category = {}, {}
    for f in findings:
        per_rule[f["rule"]] = per_rule.get(f["rule"], 0) + SEVERITY_WEIGHT.get(f["severity"], 0)
        category[f["rule"]] = f["category"]
    load = dict.fromkeys(DIMS, 0)
    for rid, points in per_rule.items():
        if category[rid] in load:
            load[category[rid]] += min(RULE_CAP, points)
    dims = {d: (max(0, 4 - load[d]) if d in applicable else None) for d in DIMS}
    scored = [v for v in dims.values() if v is not None]
    score = _round_half_up(100 * sum(scored) / (4 * len(scored))) if scored else 100
    has_error = any(f["severity"] == "error" for f in findings)
    verdict = "rewrite" if has_error or score < 50 else "tighten" if score < 85 else "ship"
    judge = sorted(r["id"] for r in rules if r.get("engine") == "judge"
                   and (watchouts or r.get("category") != "watchout"))
    return {"score": score, "verdict": verdict, "dims": dims,
            "na": [d for d in DIMS if dims[d] is None], "findings": findings,
            "watchouts": scan(text, rules, "original") if watchouts else [],
            "judge_rules": judge}


# --------------------------------------------------------------------------- files

def _read_text(path):
    p = Path(path)
    if p.suffix.lower() not in TEXT_SUFFIXES:
        raise NoroError(f"{p}: input must be .txt or .md; convert docx, PDF and slides to text first")
    if not p.is_file():
        raise NoroError(f"file not found: {p}")
    return p.read_text(encoding="utf-8-sig")


def _load_ledger(path, create=False):
    p = Path(path)
    if not p.is_file():
        if create:
            return {"source": None, "word_count": 0, "numbers": []}
        raise NoroError(f"ledger not found: {p} (run extract --out first)")
    try:
        ledger = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise NoroError(f"ledger is not valid JSON: {p}: {exc}") from None
    if not isinstance(ledger, dict) or not isinstance(ledger.get("numbers"), list):
        raise NoroError(f"ledger has no 'numbers' list: {p}")
    return ledger


def _save_ledger(path, ledger):
    Path(path).write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _split_ids(raw):
    ids = [i.strip() for i in raw.split(",") if i.strip()]
    if not ids:
        raise NoroError("--ids needs at least one id")
    return ids


# --------------------------------------------------------------------------- commands

def cmd_extract(args):
    """extract REPORT [--out LEDGER]: list every metric number in a report.

    Text numbers are the source of truth, so they start confirmed. Identifiers,
    dates, times, years, ranks and heading numbers are skipped. With --out the
    result is also written as the ledger file the other commands use.
    """
    text = _read_text(args.report)
    ledger = {"source": args.report, "word_count": word_count(text),
              "numbers": extract_numbers(text)}
    if args.out:
        _save_ledger(args.out, ledger)
    return ledger, 0


def cmd_ledger_add(args):
    """ledger-add --ledger L --raw R [--context C] [--source image]: add a number read off an image.

    The entry gets an id i1, i2, ... and stays unconfirmed until `confirm`.
    A missing ledger file is created, for reports that are only an image.
    """
    ledger = _load_ledger(args.ledger, create=True)
    toks = _scan_numbers(args.raw)
    if not toks:
        raise NoroError(f"no number found in --raw {args.raw!r}")
    t = toks[0]
    entry = {"id": _next_id(ledger, "i"), "raw": args.raw.strip(), "value": t["value"],
             "unit": t["unit"], "kind": t["kind"], "context": args.context or "", "span": None,
             "origin": args.source, "confirmed": False}
    ledger["numbers"].append(entry)
    _save_ledger(args.ledger, ledger)
    return entry, 0


def cmd_derive(args):
    """derive --ledger L --op OP --ids a,b [--label T]: compute a number the original lacks.

    The result (d1, d2, ...) is unconfirmed; show the formula to the user and run
    `confirm` before the rewrite uses it. See derive_number for the math.
    """
    ledger = _load_ledger(args.ledger)
    entry = derive_number(ledger, args.op, _split_ids(args.ids), args.label)
    _save_ledger(args.ledger, ledger)
    return entry, 0


def cmd_confirm(args):
    """confirm --ledger L --ids d1,i3: mark numbers as confirmed by the user."""
    ledger = _load_ledger(args.ledger)
    ids = _split_ids(args.ids)
    by_id = {n.get("id"): n for n in ledger["numbers"]}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise NoroError(f"unknown ledger ids: {', '.join(missing)}")
    for i in ids:
        by_id[i]["confirmed"] = True
    _save_ledger(args.ledger, ledger)
    return {"confirmed": ids, "ledger": args.ledger}, 0


def cmd_check(args):
    """check REWRITE --ledger L --original R [--rules F]: gate a rewrite before it ships.

    Passes (exit 0) only when every number traces to the ledger, none of those
    is unconfirmed, the rewrite has fewer words than the original, and no rule
    of severity "error" fires. Otherwise exit 2.
    """
    rewrite, original = _read_text(args.rewrite), _read_text(args.original)
    ledger = _load_ledger(args.ledger)
    rules = load_rules(args.rules or DEFAULT_RULES)
    result = trace(rewrite, ledger)
    tells = scan(rewrite, rules, "text")
    ow, rw = word_count(original), word_count(rewrite)
    ok = (not result["untraced"] and not result["unconfirmed"] and rw < ow
          and not any(f["severity"] == "error" for f in tells))
    code = 0 if ok else 2
    return {"pass": ok, "untraced": result["untraced"], "unconfirmed": result["unconfirmed"],
            "length": {"original_words": ow, "rewrite_words": rw, "shorter": rw < ow},
            "tells": tells, "traced": result["traced"], "exit": code}, code


def cmd_grade(args):
    """grade REPORT [--rules F] [--watchouts]: score a report and give a verdict.

    Each finding weighs error 4, warning 1, advisory 0; one rule adds at most 2
    points; each dimension scores max(0, 4 - points). Dimensions without
    applicable rules are n/a. Verdict: any error or score < 50 -> rewrite,
    score < 85 -> tighten, else ship. --watchouts also runs watchout rules.
    """
    text = _read_text(args.report)
    return grade_text(text, load_rules(args.rules or DEFAULT_RULES), args.watchouts), 0


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        _emit({"error": message, "usage": self.format_usage().strip()})
        sys.exit(1)


def build_parser():
    p = _Parser(prog="noro.py", description="noro engine: number ledger, tracing and slop rules.")
    p.add_argument("--version", action="version", version=VERSION)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    sub.required = True

    def add(name, func):
        sp = sub.add_parser(name, help=func.__doc__.splitlines()[0], description=func.__doc__)
        sp.set_defaults(func=func)
        return sp

    sp = add("extract", cmd_extract)
    sp.add_argument("report")
    sp.add_argument("--out")
    sp = add("ledger-add", cmd_ledger_add)
    sp.add_argument("--ledger", required=True)
    sp.add_argument("--raw", required=True)
    sp.add_argument("--context", default="")
    sp.add_argument("--source", default="image")
    sp = add("derive", cmd_derive)
    sp.add_argument("--ledger", required=True)
    sp.add_argument("--op", required=True, choices=OPS)
    sp.add_argument("--ids", required=True)
    sp.add_argument("--label")
    sp = add("confirm", cmd_confirm)
    sp.add_argument("--ledger", required=True)
    sp.add_argument("--ids", required=True)
    sp = add("check", cmd_check)
    sp.add_argument("rewrite")
    sp.add_argument("--ledger", required=True)
    sp.add_argument("--original", required=True)
    sp.add_argument("--rules")
    sp = add("grade", cmd_grade)
    sp.add_argument("report")
    sp.add_argument("--rules")
    sp.add_argument("--watchouts", action="store_true")
    return p


def _emit(payload):
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    args = build_parser().parse_args(argv)
    try:
        payload, code = args.func(args)
    except NoroError as exc:
        payload, code = {"error": str(exc)}, 1
    _emit(payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
