"""Clock and date helpers. A time of day is a number of minutes since midnight."""
import datetime


def parse_clock(text):
    hours, _, minutes = text.partition(":")
    if not (hours.isdigit() and minutes.isdigit() and len(minutes) == 2):
        raise ValueError(f"not a time of day: {text!r}")
    value = int(hours) * 60 + int(minutes)
    if int(minutes) > 59 or value > 24 * 60:
        raise ValueError(f"not a time of day: {text!r}")
    return value


def format_clock(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse_day(text):
    return datetime.date.fromisoformat(text)


def overlaps(start_a, end_a, start_b, end_b):
    """Half-open intervals: two that only touch do not overlap."""
    return start_a < end_b and start_b < end_a
