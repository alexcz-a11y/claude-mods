"""Recurring bookings: one entry of series.json stands for many days."""
from .timeutil import parse_clock, parse_day


def occurs_on(series, day):
    if day < parse_day(series["from"]) or day > parse_day(series["until"]):
        return False
    if day.isoformat() in series.get("skip", ()):
        return False
    return day.weekday() in series["weekdays"]


def occurrences(all_series, room_id, day):
    """(start, end, title) of every series that takes the room on that day."""
    found = []
    for series in all_series:
        if series["room"] != room_id or not occurs_on(series, day):
            continue
        found.append((parse_clock(series["start"]), parse_clock(series["end"]), series["title"]))
    return found
