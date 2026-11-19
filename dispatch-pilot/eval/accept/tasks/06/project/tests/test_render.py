import unittest

from standings.render import render
from standings.results import Match
from standings.table import standings


class RenderTest(unittest.TestCase):
    def setUp(self):
        rows = standings([Match("Alder Green", "Brook End", 2, 0), Match("Alder Green", "Castle Mill", 1, 1)])
        self.lines = render("Division One", rows).splitlines()

    def test_the_name_then_the_heading_then_one_line_per_team(self):
        self.assertEqual(self.lines[0], "Division One")
        self.assertEqual(self.lines[1].split()[:2], ["#", "Team"])
        self.assertEqual(self.lines[1].split()[-1], "Pts")
        self.assertEqual(len(self.lines), 5)

    def test_a_team_line_starts_with_place_and_name_and_ends_with_points(self):
        self.assertEqual(self.lines[2].split()[:3], ["1", "Alder", "Green"])
        self.assertEqual(self.lines[2].split()[-1], "4")
        self.assertEqual(self.lines[4].split()[:3], ["3", "Brook", "End"])

    def test_columns_line_up(self):
        self.assertEqual(len({len(line) for line in self.lines[1:]}), 1)


if __name__ == "__main__":
    unittest.main()
