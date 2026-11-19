"""Runs reports and writes what they return."""
import json
import os

from .reports import REPORTS


def run_report(backend, name, day):
    return REPORTS[name](backend, day)


def run_all(backend, day, out_dir, only=None):
    names = sorted(REPORTS) if not only else list(only)
    unknown = [name for name in names if name not in REPORTS]
    if unknown:
        raise SystemExit(f"unknown report: {', '.join(unknown)}")
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for name in names:
        rows = run_report(backend, name, day)
        path = os.path.join(out_dir, f"{name}.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        written.append(path)
    return written
