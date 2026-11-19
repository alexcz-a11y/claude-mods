"""Hidden checks for task 01. Drives the roombook command line against its own data directory."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FREE, TAKEN = "free", "not available"

# (label, room, day, start, end, expected). 2031-03-03 is a Monday.
CASES = [
    ("the reported slot: last hour of a Tuesday", "B", "2031-03-04", "17:00", "18:00", FREE),
    ("last hour of the day, nothing booked", "R1", "2031-03-05", "16:00", "18:00", FREE),
    ("runs past closing", "R1", "2031-03-05", "17:30", "18:30", TAKEN),
    ("starts before opening", "R1", "2031-03-05", "07:30", "08:30", TAKEN),
    ("first hour of the day", "R1", "2031-03-05", "08:00", "09:00", FREE),
    ("longer than the room allows", "R1", "2031-03-05", "09:00", "12:00", TAKEN),
    ("Monday series on a Monday", "R1", "2031-03-03", "17:00", "18:00", TAKEN),
    ("right before the Monday series", "R1", "2031-03-03", "16:00", "17:00", FREE),
    ("Monday series on a Tuesday", "R1", "2031-03-04", "17:00", "18:00", FREE),
    ("Monday series on a skipped Monday", "R1", "2031-03-17", "17:00", "18:00", FREE),
    ("Monday series on its last day", "R1", "2031-06-30", "17:00", "18:00", TAKEN),
    ("Monday series after it ended", "R1", "2031-07-07", "17:00", "18:00", FREE),
    ("Sunday series on a Sunday", "R2", "2031-03-09", "10:00", "11:00", TAKEN),
    ("Sunday series on a Saturday", "R2", "2031-03-08", "10:00", "11:00", FREE),
    ("weekend series on a Saturday", "R2", "2031-03-08", "15:00", "16:00", TAKEN),
    ("weekend series on a Sunday", "R2", "2031-03-09", "15:30", "16:30", TAKEN),
    ("weekend series on a Monday", "R2", "2031-03-10", "15:00", "16:00", FREE),
    ("weekend series on a Friday", "R2", "2031-03-07", "15:00", "16:00", FREE),
    ("Wednesday series on a Wednesday", "R2", "2031-03-12", "08:00", "09:00", TAKEN),
    ("Wednesday series on a Thursday", "R2", "2031-03-13", "08:00", "09:00", FREE),
    ("Wednesday series before it starts", "R2", "2031-03-05", "08:00", "09:00", FREE),
    ("overlaps a one-off booking", "R1", "2031-03-06", "10:30", "11:30", TAKEN),
    ("inside a one-off booking", "R1", "2031-03-06", "10:15", "10:45", TAKEN),
    ("right after a one-off booking", "R1", "2031-03-06", "11:00", "12:00", FREE),
    ("right before a one-off booking", "R1", "2031-03-06", "09:00", "10:00", FREE),
]


def run(target, data_dir, *args):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    try:
        done = subprocess.run(
            [sys.executable, "-B", "-m", "roombook", "--data", data_dir, *args],
            cwd=target, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
    except subprocess.TimeoutExpired:
        return None, "timed out"
    return done.returncode, (done.stdout + done.stderr).strip()


def answer(code):
    return {0: FREE, 1: TAKEN}.get(code, f"exit code {code}")


def main():
    target = sys.argv[1]
    work = tempfile.mkdtemp(prefix="accept01-")
    failures = []
    try:
        data_dir = os.path.join(work, "data")
        shutil.copytree(os.path.join(HERE, "data"), data_dir)

        for label, room, day, start, end, expected in CASES:
            code, output = run(target, data_dir, "check", room, day, start, end)
            got = answer(code)
            if got != expected:
                failures.append(f"check {room} {day} {start}-{end} ({label}): expected {expected}, got {got}")

        # Booking writes, and what it wrote blocks the slot afterwards.
        code, output = run(target, data_dir, "book", "R2", "2031-03-11", "13:00", "14:00", "--title", "hidden")
        if code != 0:
            failures.append(f"book R2 2031-03-11 13:00-14:00: expected success, got {answer(code)}: {output}")
        else:
            with open(os.path.join(data_dir, "bookings.json"), encoding="utf-8") as handle:
                stored = json.load(handle)
            if not any(b.get("room") == "R2" and b.get("day") == "2031-03-11" and b.get("title") == "hidden" for b in stored):
                failures.append("book R2 2031-03-11 13:00-14:00: the booking is not in bookings.json")
            code, _ = run(target, data_dir, "book", "R2", "2031-03-11", "13:30", "14:30", "--title", "clash")
            if answer(code) != TAKEN:
                failures.append(f"book over a booking just made: expected {TAKEN}, got {answer(code)}")
            code, _ = run(target, data_dir, "check", "R2", "2031-03-11", "14:00", "15:00")
            if answer(code) != FREE:
                failures.append(f"check right after a booking just made: expected {FREE}, got {answer(code)}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    for line in failures:
        print("FAIL " + line)
    print(f"{len(CASES) + 4 - len(failures)} of {len(CASES) + 4} checks passed" if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
