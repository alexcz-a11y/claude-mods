"""What already takes up a room on a given day."""
from . import series as series_rules
from .timeutil import parse_clock


def busy_intervals(data, room_id, day):
    """Sorted (start, end, title) of everything in the room that day."""
    busy = []
    for booking in data["bookings"]:
        if booking["room"] == room_id and booking["day"] == day.isoformat():
            busy.append((parse_clock(booking["start"]), parse_clock(booking["end"]), booking["title"]))
    busy.extend(series_rules.occurrences(data["series"], room_id, day))
    return sorted(busy)
