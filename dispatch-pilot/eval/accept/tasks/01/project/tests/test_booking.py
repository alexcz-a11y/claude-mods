import datetime
import unittest

from roombook import booking
from roombook.timeutil import parse_clock

DATA = {
    "rooms": {
        "A": {"name": "A", "opens": "08:00", "closes": "20:00", "max_minutes": 240},
    },
    "bookings": [
        {"id": "b-0001", "room": "A", "day": "2031-03-05", "start": "10:00", "end": "12:00", "title": "培训"},
    ],
    "series": [
        {
            "id": "s-01",
            "room": "A",
            "title": "工作日站会",
            "weekdays": [1, 2, 3, 4, 5],
            "start": "09:30",
            "end": "09:45",
            "from": "2031-01-02",
            "until": "2031-12-31",
        },
    ],
}

WEDNESDAY = datetime.date(2031, 3, 5)


def request(start, end, day=WEDNESDAY, room="A"):
    return booking.Request(room=room, day=day, start=parse_clock(start), end=parse_clock(end))


class Availability(unittest.TestCase):
    def test_free_slot(self):
        self.assertTrue(booking.is_available(DATA, request("13:00", "14:00")))

    def test_overlapping_a_booking(self):
        self.assertFalse(booking.is_available(DATA, request("11:30", "12:30")))

    def test_right_after_a_booking(self):
        self.assertTrue(booking.is_available(DATA, request("12:00", "13:00")))

    def test_standup_blocks_its_slot(self):
        self.assertFalse(booking.is_available(DATA, request("09:00", "10:00")))

    def test_unknown_room(self):
        self.assertFalse(booking.is_available(DATA, request("13:00", "14:00", room="Z")))

    def test_end_before_start(self):
        self.assertFalse(booking.is_available(DATA, request("14:00", "13:00")))


class Recording(unittest.TestCase):
    def test_ids_count_up(self):
        data = {"rooms": DATA["rooms"], "bookings": list(DATA["bookings"]), "series": []}
        made = booking.record(data, request("15:00", "16:00"), "复盘")
        self.assertEqual(made["id"], "b-0002")
        self.assertEqual(made["start"], "15:00")


if __name__ == "__main__":
    unittest.main()
