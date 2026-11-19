"""Turns the matches of one division into the rows of its table."""

from dataclasses import dataclass

WIN_POINTS = 3
DRAW_POINTS = 1


@dataclass
class Row:
    team: str
    played: int = 0
    won: int = 0
    drawn: int = 0
    lost: int = 0

    @property
    def points(self):
        return WIN_POINTS * self.won + DRAW_POINTS * self.drawn


def standings(matches):
    """The rows of the table, best team first."""
    rows = {}
    for match in matches:
        home = rows.setdefault(match.home, Row(match.home))
        away = rows.setdefault(match.away, Row(match.away))
        home.played += 1
        away.played += 1
        if match.home_goals > match.away_goals:
            home.won += 1
            away.lost += 1
        elif match.home_goals < match.away_goals:
            away.won += 1
            home.lost += 1
        else:
            home.drawn += 1
            away.drawn += 1
    return sorted(rows.values(), key=lambda row: (-row.points, row.team))
