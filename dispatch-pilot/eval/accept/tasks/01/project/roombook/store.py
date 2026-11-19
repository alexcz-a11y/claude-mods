"""Reading and writing the data directory."""
import json
import os


def _read(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load(data_dir):
    return {
        "rooms": _read(os.path.join(data_dir, "rooms.json")),
        "bookings": _read(os.path.join(data_dir, "bookings.json")),
        "series": _read(os.path.join(data_dir, "series.json")),
    }


def save_bookings(data_dir, bookings):
    path = os.path.join(data_dir, "bookings.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(bookings, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
