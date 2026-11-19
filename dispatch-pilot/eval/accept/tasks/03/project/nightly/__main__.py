import argparse
import sys

from .backend import Backend
from .runner import run_all


def main(argv=None):
    parser = argparse.ArgumentParser(prog="nightly")
    parser.add_argument("day", help="the day to report on, YYYY-MM-DD")
    parser.add_argument("--db", default="fixtures/db.json", help="local stand-in for the data service")
    parser.add_argument("--out", default="out", help="directory the reports are written to")
    parser.add_argument("--only", action="append", help="run just this report (may be repeated)")
    args = parser.parse_args(argv)

    backend = Backend.from_file(args.db)
    written = run_all(backend, args.day, args.out, only=args.only)
    print(f"{len(written)} reports written to {args.out}/ · backend calls: {backend.calls}")
    return 0


sys.exit(main())
