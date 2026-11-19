"""Rules of a room that a request has to satisfy before the agenda is looked at."""
from .timeutil import parse_clock


def inside_opening_hours(room, start, end):
    opens = parse_clock(room["opens"])
    closes = parse_clock(room["closes"])
    return opens <= start and end < closes


def within_max_length(room, start, end):
    limit = room.get("max_minutes")
    return limit is None or end - start <= limit
