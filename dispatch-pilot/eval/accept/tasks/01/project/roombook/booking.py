"""Deciding whether a request can be booked, and recording it."""
import datetime
from dataclasses import dataclass

from . import agenda, rules
from .timeutil import format_clock, overlaps


@dataclass(frozen=True)
class Request:
    room: str
    day: datetime.date
    start: int
    end: int


def is_available(data, request):
    room = data["rooms"].get(request.room)
    if room is None:
        return False
    if request.end <= request.start:
        return False
    if not rules.inside_opening_hours(room, request.start, request.end):
        return False
    if not rules.within_max_length(room, request.start, request.end):
        return False
    for start, end, _title in agenda.busy_intervals(data, request.room, request.day):
        if overlaps(request.start, request.end, start, end):
            return False
    return True


def next_id(bookings):
    numbers = [int(b["id"][2:]) for b in bookings if b["id"].startswith("b-")]
    return f"b-{max(numbers, default=0) + 1:04d}"


def record(data, request, title):
    booking = {
        "id": next_id(data["bookings"]),
        "room": request.room,
        "day": request.day.isoformat(),
        "start": format_clock(request.start),
        "end": format_clock(request.end),
        "title": title,
    }
    data["bookings"].append(booking)
    return booking


def cancel(data, booking_id):
    for index, booking in enumerate(data["bookings"]):
        if booking["id"] == booking_id:
            return data["bookings"].pop(index)
    return None
