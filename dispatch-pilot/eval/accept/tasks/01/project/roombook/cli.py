"""The command line: rooms, check, book, cancel."""
import argparse
import sys

from . import booking, store
from .timeutil import format_clock, parse_clock, parse_day


def build_parser():
    parser = argparse.ArgumentParser(prog="roombook")
    parser.add_argument("--data", default="data", help="data directory (default: ./data)")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("rooms", help="list the rooms")

    for name, text in (("check", "say whether a slot can be booked"), ("book", "book a slot")):
        sub = commands.add_parser(name, help=text)
        sub.add_argument("room")
        sub.add_argument("day")
        sub.add_argument("start")
        sub.add_argument("end")
        if name == "book":
            sub.add_argument("--title", required=True)

    sub = commands.add_parser("cancel", help="cancel a booking by id")
    sub.add_argument("booking_id")
    return parser


def _request(args):
    return booking.Request(
        room=args.room,
        day=parse_day(args.day),
        start=parse_clock(args.start),
        end=parse_clock(args.end),
    )


def _slot(request):
    return f"{request.day.isoformat()} {format_clock(request.start)}-{format_clock(request.end)}"


def main(argv=None):
    args = build_parser().parse_args(argv)
    data = store.load(args.data)

    if args.command == "rooms":
        for room_id, room in sorted(data["rooms"].items()):
            print(f"{room_id}  {room['opens']}-{room['closes']}  {room['name']}")
        return 0

    if args.command == "cancel":
        removed = booking.cancel(data, args.booking_id)
        if removed is None:
            print(f"error: no booking {args.booking_id}", file=sys.stderr)
            return 1
        store.save_bookings(args.data, data["bookings"])
        print(f"cancelled: {removed['id']} {removed['title']}")
        return 0

    if args.room not in data["rooms"]:
        print(f"error: unknown room {args.room}", file=sys.stderr)
        return 2
    try:
        request = _request(args)
    except ValueError as problem:
        print(f"error: {problem}", file=sys.stderr)
        return 2

    if not booking.is_available(data, request):
        print(f"error: {request.room} is not available on {_slot(request)}", file=sys.stderr)
        return 1

    if args.command == "check":
        print(f"free: {request.room} {_slot(request)}")
        return 0

    made = booking.record(data, request, args.title)
    store.save_bookings(args.data, data["bookings"])
    print(f"booked: {made['id']} {request.room} {_slot(request)} {made['title']}")
    return 0
