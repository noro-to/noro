#!/usr/bin/env python3
"""Build dist/noro.zip for the Claude.ai skill upload.

Claude.ai wants the skill folder at the zip root, named after the skill:

    noro.zip
    └── noro/
        ├── SKILL.md
        ├── LICENSE
        ├── reference/
        ├── personas/
        └── scripts/  (noro.py, rules.json)

Source: skills/noro/. Skips __pycache__, dotfiles, compiled Python and tests.
Fails if SKILL.md or scripts/rules.json is missing, if rules.json is not valid
JSON, or if the SKILL.md frontmatter name does not match the folder name.

Usage: python tools/build_zip.py [--src skills/noro] [--out dist/noro.zip]
Stdlib only.
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESCRIPTION_LIMIT = 200  # Claude.ai "Creating custom skills": description max 200 characters
NAME_LIMIT = 64
FIXED_TIME = (1980, 1, 1, 0, 0, 0)  # same bytes on every build


def fail(msg):
    print(f"build_zip: error: {msg}", file=sys.stderr)
    sys.exit(1)


def frontmatter(text):
    """Read top-level `key: value` pairs from YAML frontmatter, including folded values."""
    lines = text.lstrip("﻿").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    fields, key = {}, None
    for line in lines[1:]:
        if line.strip() == "---":
            return {k: " ".join(v).strip() for k, v in fields.items()}
        if line[:1] in (" ", "\t") and key:
            fields[key].append(line.strip())
        elif ":" in line:
            key, value = line.split(":", 1)
            key, value = key.strip(), value.strip()
            fields[key] = [] if value in (">", "|", ">-", "|-", "") else [value.strip("'\"")]
    return None


def skipped(rel):
    parts = rel.parts
    if any(p.startswith(".") or p == "__pycache__" for p in parts):
        return True
    if any(p in ("tests", "test") for p in parts[:-1]):
        return True
    name = parts[-1]
    return (
        name.endswith((".pyc", ".pyo"))
        or (name.startswith("test_") and name.endswith(".py"))
        or name.endswith("_test.py")
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", default=str(ROOT / "skills" / "noro"))
    ap.add_argument("--out", default=str(ROOT / "dist" / "noro.zip"))
    args = ap.parse_args()

    src, out = Path(args.src).resolve(), Path(args.out).resolve()
    folder = src.name

    skill_md = src / "SKILL.md"
    rules = src / "scripts" / "rules.json"
    if not skill_md.is_file():
        fail(f"missing {skill_md}")
    if not rules.is_file():
        fail(f"missing {rules} (run: python tools/build_rules.py)")
    try:
        json.loads(rules.read_text(encoding="utf-8"))
    except ValueError as e:
        fail(f"{rules} is not valid JSON: {e}")

    meta = frontmatter(skill_md.read_text(encoding="utf-8"))
    if meta is None:
        fail("SKILL.md must start with YAML frontmatter between --- lines")
    name, desc = meta.get("name", ""), meta.get("description", "")
    if not name or not desc:
        fail("SKILL.md frontmatter needs both name and description")
    if name != folder:
        fail(f"SKILL.md name '{name}' must match the folder name '{folder}'")
    if len(name) > NAME_LIMIT:
        fail(f"SKILL.md name is {len(name)} characters; the limit is {NAME_LIMIT}")
    if len(desc) > DESCRIPTION_LIMIT:
        print(
            f"build_zip: warning: description is {len(desc)} characters; "
            f"Claude.ai documents a {DESCRIPTION_LIMIT}-character limit",
            file=sys.stderr,
        )

    files = sorted(
        p for p in src.rglob("*") if p.is_file() and not skipped(p.relative_to(src))
    )
    extras = [(ROOT / "LICENSE", f"{folder}/LICENSE")] if (ROOT / "LICENSE").is_file() else []

    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        entries = [(p, f"{folder}/{p.relative_to(src).as_posix()}") for p in files]
        for path, arc in sorted(entries + extras, key=lambda e: e[1]):
            info = zipfile.ZipInfo(arc, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
            print(arc)

    print(f"wrote {out} ({out.stat().st_size} bytes, {len(entries) + len(extras)} files)")


if __name__ == "__main__":
    main()
