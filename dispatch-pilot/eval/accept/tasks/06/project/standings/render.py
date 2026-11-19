"""Lays the rows of a table out as text."""

# Heading of each number column and the attribute of a row it shows.
COLUMNS = (
    ("P", "played"),
    ("W", "won"),
    ("D", "drawn"),
    ("L", "lost"),
    ("Pts", "points"),
)


def render(name, rows):
    """The table of one division: its name, a heading line, then one line per team."""
    width = max([len("Team")] + [len(row.team) for row in rows])
    lines = [name, f"{'#':>2}  {'Team':<{width}}" + "".join(f"{heading:>5}" for heading, _ in COLUMNS)]
    for place, row in enumerate(rows, start=1):
        numbers = "".join(f"{getattr(row, attribute):>5}" for _, attribute in COLUMNS)
        lines.append(f"{place:>2}  {row.team:<{width}}{numbers}")
    return "\n".join(lines)
