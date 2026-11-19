"""The command line: python3 -m standings <results file>."""

import argparse
import sys

from .render import render
from .results import ResultsError, parse
from .table import standings


def main(argv=None):
    parser = argparse.ArgumentParser(prog="standings", description="League tables from a results file.")
    parser.add_argument("results", help="the results file")
    args = parser.parse_args(argv)

    try:
        with open(args.results, encoding="utf-8") as handle:
            divisions = parse(handle.read())
    except (OSError, ResultsError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print("\n\n".join(render(division.name, standings(division.matches)) for division in divisions))
    return 0
