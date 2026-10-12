"""Shared paths and a CLI runner for the engine tests (not a test module)."""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "noro" / "scripts"
NORO = SCRIPTS / "noro.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
RULES = FIXTURES / "rules.json"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import noro  # noqa: E402  (re-exported for the tests)


def run(*args):
    """Run noro.py with args; return (exit_code, parsed_json_or_None, stderr)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    proc = subprocess.run([sys.executable, str(NORO), *map(str, args)], capture_output=True,
                          text=True, encoding="utf-8", env=env)
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        data = None
    return proc.returncode, data, proc.stderr


def write(directory, name, text):
    path = Path(directory) / name
    path.write_text(text, encoding="utf-8")
    return path
