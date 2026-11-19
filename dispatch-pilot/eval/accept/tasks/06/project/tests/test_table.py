import unittest

from standings.results import Match
from standings.table import standings


def row(rows, team):
    return next(found for found in rows if found.team == team)


class StandingsTest(unittest.TestCase):
    def test_wins_draws_and_losses_are_counted(self):
        rows = standings([
            Match("Alder Green", "Brook End", 2, 0),
            Match("Brook End", "Castle Mill", 1, 1),
            Match("Castle Mill", "Alder Green", 0, 1),
        ])
        alder = row(rows, "Alder Green")
        self.assertEqual((alder.played, alder.won, alder.drawn, alder.lost, alder.points), (2, 2, 0, 0, 6))
        brook = row(rows, "Brook End")
        self.assertEqual((brook.played, brook.won, brook.drawn, brook.lost, brook.points), (2, 0, 1, 1, 1))

    def test_more_points_come_first(self):
        rows = standings([
            Match("Brook End", "Alder Green", 3, 0),
            Match("Castle Mill", "Alder Green", 1, 1),
            Match("Brook End", "Castle Mill", 0, 0),
        ])
        self.assertEqual([found.team for found in rows], ["Brook End", "Castle Mill", "Alder Green"])

    def test_teams_level_in_every_respect_are_listed_alphabetically(self):
        rows = standings([Match("Dene Park", "Castle Mill", 1, 1), Match("Brook End", "Alder Green", 1, 1)])
        self.assertEqual([found.team for found in rows], ["Alder Green", "Brook End", "Castle Mill", "Dene Park"])

    def test_no_matches_no_rows(self):
        self.assertEqual(standings([]), [])


if __name__ == "__main__":
    unittest.main()
