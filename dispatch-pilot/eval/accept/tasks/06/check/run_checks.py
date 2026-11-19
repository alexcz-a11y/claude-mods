"""Hidden checks for task 06. Runs the standings command line on its own results files and compares
every row it prints (team, P, W, D, L, GF, GA, GD, Pts, in the order printed) with rows worked out here."""

import os
import re
import shutil
import subprocess
import sys
import tempfile

TARGET = sys.argv[1]

PLAIN = """
# no walkovers, no deductions: the order of teams level on points
[North]
Cinder Hill 3-1 Birchfield
Ashdown 2-0 Dunmore
Yarrow 5-4 Wexcombe
Thistle Green 2-0 Vale Road
Fennick 1-1 Eastmoor

[South]
Quay Side 2-2 Marlow End
Otter Bridge 1-0 Quay Side
Marlow End 3-0 Otter Bridge
Pine Cross 0-0 Otter Bridge
Quay Side 4-1 Pine Cross
Marlow End 1-1 Pine Cross
"""

WALKOVERS = """
[Premier]
Hollin Vale w/o Stone Cross
Stone Cross 2-1 Garth End
Garth End 1-1 Hollin Vale
Redwater w/o Garth End
Redwater 0-2 Hollin Vale
Stone Cross   w/o   Redwater
"""

DEDUCTIONS = """
[Division Two]
deduct Kingsmead 6
Kingsmead 2-0 Lowfield
Kingsmead 1-0 Norbrook
Lowfield 2-1 Norbrook
Norbrook 0-0 Parkgate
Parkgate 1-3 Kingsmead
Lowfield 1-1 Parkgate
deduct Parkgate 1

[Division One]
Abbots Wood 1-0 Crane Hill
Crane Hill 2-2 Abbots Wood
"""

EVERYTHING = """
# all of it in one file
[North]
Ashdown 2-1 Birchfield
Birchfield w/o Cinder Hill
Cinder Hill 0-0 Ashdown
deduct Ashdown 1

[Division Two]
Kingsmead 4-4 Lowfield
Norbrook w/o Kingsmead
deduct Norbrook 3
Lowfield 0-1 Norbrook

[South]
Quay Side 1-0 Marlow End
Marlow End 2-2 Tarn Lane
Tarn Lane 0-1 Quay Side
"""

# The visible season, as it would be entered once walkovers and deductions are accepted.
SEASON = """
[Division One]
Harbour Rovers 2-1 Kestrel Park
Millbrook Athletic 0-0 Old Quarry
Tannery Lane 1-3 Harbour Rovers
Kestrel Park 2-2 Millbrook Athletic
Old Quarry 1-0 Tannery Lane
Harbour Rovers 1-1 Old Quarry
Millbrook Athletic 4-0 Tannery Lane
Kestrel Park 3-0 Old Quarry
Tannery Lane 2-2 Kestrel Park
Millbrook Athletic 1-2 Harbour Rovers
Harbour Rovers w/o Millbrook Athletic
deduct Millbrook Athletic 3

[Division Two]
Saltmarsh United 1-0 Copperhill
Upper Fenwick 2-2 Lantern Street
Weir Bank 0-2 Saltmarsh United
Copperhill 3-1 Upper Fenwick
Lantern Street 1-0 Weir Bank
Saltmarsh United 0-0 Upper Fenwick
Copperhill 2-0 Weir Bank
Lantern Street 0-1 Copperhill
Weir Bank 1-1 Upper Fenwick
Lantern Street 2-1 Saltmarsh United
"""

# (label, results text, division asked for with --division or None)
CASES = [
    ("teams level on points", PLAIN, None),
    ("walkovers", WALKOVERS, None),
    ("deductions", DEDUCTIONS, None),
    ("everything in one file", EVERYTHING, None),
    ("the 2031 season with a walkover and a deduction", SEASON, None),
    ("--division North", EVERYTHING, "North"),
    ("--division 'Division Two'", EVERYTHING, "Division Two"),
    ("--division South, no walkovers or deductions", PLAIN, "South"),
    ("--division 'Division One' of the season", SEASON, "Division One"),
]


def expected(text, only):
    """The rows a correct table has, division after division in file order."""
    divisions = []
    for raw in text.splitlines():
        line = " ".join(raw.split())
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            divisions.append((line.strip("[]").strip(), {}, {}))
            continue
        _, teams, deducted = divisions[-1]
        if line.startswith("deduct "):
            team, points = line[len("deduct "):].rsplit(" ", 1)
            deducted[team] = deducted.get(team, 0) + int(points)
            continue
        if " w/o " in line:
            home, away = line.split(" w/o ")
            home_goals, away_goals = 3, 0
        else:
            found = re.match(r"^(.+?) (\d+)-(\d+) (.+)$", line)
            home, away = found[1], found[4]
            home_goals, away_goals = int(found[2]), int(found[3])
        for team, scored, conceded in ((home, home_goals, away_goals), (away, away_goals, home_goals)):
            tally = teams.setdefault(team, {"P": 0, "W": 0, "D": 0, "L": 0, "GF": 0, "GA": 0})
            tally["P"] += 1
            tally["GF"] += scored
            tally["GA"] += conceded
            tally["W" if scored > conceded else "L" if scored < conceded else "D"] += 1
    rows = []
    for name, teams, deducted in divisions:
        if only is not None and name != only:
            continue
        table = []
        for team, t in teams.items():
            points = 3 * t["W"] + t["D"] - deducted.get(team, 0)
            table.append((team, t["P"], t["W"], t["D"], t["L"], t["GF"], t["GA"], t["GF"] - t["GA"], points))
        table.sort(key=lambda r: (-r[8], -r[7], -r[5], r[0]))
        rows.extend(table)
    return rows


NUMBER = re.compile(r"^[+-]?\d+$")
PLACE = re.compile(r"^\d+[.)]?$")


def rows_printed(output):
    """Every printed line that ends in eight whole numbers is a team's row; what stands before them
    is the team, less a leading place number."""
    rows = []
    for raw in output.splitlines():
        words = raw.replace("*", " ").replace("|", " ").replace("−", "-").split()
        if len(words) < 9 or not all(NUMBER.match(word) for word in words[-8:]):
            continue
        name = words[:-8]
        if len(name) >= 2 and PLACE.match(name[0]):
            name = name[1:]
        rows.append((" ".join(name), *(int(word) for word in words[-8:])))
    return rows


def show(rows):
    return "; ".join(f"{row[0]} {' '.join(str(number) for number in row[1:])}" for row in rows) or "(no rows)"


def main():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    work = tempfile.mkdtemp(prefix="accept06-")
    failures = []
    try:
        for index, (label, text, only) in enumerate(CASES):
            path = os.path.join(work, f"results-{index}.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text.lstrip("\n"))
            command = [sys.executable, "-B", "-m", "standings", path]
            if only is not None:
                command += ["--division", only]
            try:
                done = subprocess.run(command, cwd=TARGET, env=env, capture_output=True, text=True, timeout=30)
            except subprocess.TimeoutExpired:
                failures.append(f"{label}: no answer within 30 seconds")
                continue
            if done.returncode != 0:
                tail = (done.stderr.strip().splitlines() or ["(nothing on stderr)"])[-1]
                failures.append(f"{label}: exit {done.returncode}: {tail}")
                continue
            got, want = rows_printed(done.stdout), expected(text, only)
            if got != want:
                failures.append(f"{label}:\n      printed  {show(got)}\n      expected {show(want)}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if failures:
        print(f"FAIL ({len(failures)})")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PASS")
    return 0


sys.exit(main())
