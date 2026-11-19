import unittest

from roombook import rules
from roombook.timeutil import overlaps, parse_clock

ROOM = {"name": "T", "opens": "08:00", "closes": "18:00", "max_minutes": 120}


def clock(text):
    return parse_clock(text)


class OpeningHours(unittest.TestCase):
    def test_inside(self):
        self.assertTrue(rules.inside_opening_hours(ROOM, clock("10:00"), clock("11:00")))

    def test_first_slot_of_the_day(self):
        self.assertTrue(rules.inside_opening_hours(ROOM, clock("08:00"), clock("09:00")))

    def test_before_opening(self):
        self.assertFalse(rules.inside_opening_hours(ROOM, clock("07:30"), clock("08:30")))

    def test_past_closing(self):
        self.assertFalse(rules.inside_opening_hours(ROOM, clock("17:30"), clock("18:30")))


class Length(unittest.TestCase):
    def test_at_the_limit(self):
        self.assertTrue(rules.within_max_length(ROOM, clock("10:00"), clock("12:00")))

    def test_over_the_limit(self):
        self.assertFalse(rules.within_max_length(ROOM, clock("10:00"), clock("12:30")))


class Overlap(unittest.TestCase):
    def test_touching_is_not_overlapping(self):
        self.assertFalse(overlaps(clock("09:00"), clock("10:00"), clock("10:00"), clock("11:00")))

    def test_partial(self):
        self.assertTrue(overlaps(clock("09:00"), clock("10:30"), clock("10:00"), clock("11:00")))


if __name__ == "__main__":
    unittest.main()
