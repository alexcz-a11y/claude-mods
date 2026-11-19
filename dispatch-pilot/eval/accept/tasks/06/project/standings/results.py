"""Reads a results file: the divisions and the matches played in each."""

import re
from dataclasses import dataclass, field

HEADER = re.compile(r"^\[(?P<name>[^\]]+)\]$")
MATCH = re.compile(r"^(?P<home>.+?)\s+(?P<home_goals>\d+)-(?P<away_goals>\d+)\s+(?P<away>.+)$")


class ResultsError(ValueError):
    """A line of the results file that cannot be read."""


@dataclass(frozen=True)
class Match:
    home: str
    away: str
    home_goals: int
    away_goals: int


@dataclass
class Division:
    name: str
    matches: list = field(default_factory=list)


def clean(name):
    """A name as it is compared and printed: single spaces, none at the ends."""
    return " ".join(name.split())


def parse(text):
    """The divisions of a results file, in the order they appear."""
    divisions = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = HEADER.match(line)
        if header:
            divisions.append(Division(clean(header["name"])))
            continue
        if not divisions:
            raise ResultsError(f"line {number}: a result before the first [division] line")
        divisions[-1].matches.append(read_match(line, number))
    return divisions


def read_match(line, number):
    found = MATCH.match(line)
    if not found:
        raise ResultsError(f"line {number}: cannot read {line!r}")
    home, away = clean(found["home"]), clean(found["away"])
    if home == away:
        raise ResultsError(f"line {number}: {home} cannot play itself")
    return Match(home, away, int(found["home_goals"]), int(found["away_goals"]))
