"""Hidden checks for task 03: every report gives the same rows as before, in at most 5 backend calls."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUDGET = 5


def main():
    target = sys.argv[1]
    with open(os.path.join(HERE, "expected.json"), encoding="utf-8") as handle:
        expected = json.load(handle)

    work = tempfile.mkdtemp(prefix="accept03-")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONHASHSEED="0", PYTHONIOENCODING="utf-8")
    failures = []
    try:
        results_path = os.path.join(work, "results.json")
        try:
            done = subprocess.run(
                [sys.executable, "-B", os.path.join(HERE, "harness.py"), target, os.path.join(HERE, "db.json"), results_path],
                cwd=target, env=env, capture_output=True, text=True, encoding="utf-8", timeout=180,
            )
            crashed = None if done.returncode == 0 else (done.stderr.strip().splitlines() or ["no output"])[-1]
        except subprocess.TimeoutExpired:
            crashed = "timed out"
        if crashed or not os.path.exists(results_path):
            print(f"FAIL the reports could not be run: {crashed}")
            return 1
        with open(results_path, encoding="utf-8") as handle:
            results = json.load(handle)

        over, changed, broken = [], [], []
        for key in sorted(expected):
            got = results.get(key)
            if got is None or "error" in got:
                broken.append(f"{key}: {got['error'] if got else 'did not run'}")
            elif got["rows"] != expected[key]:
                changed.append(key)
            elif got["calls"] > BUDGET:
                over.append(f"{key}: {got['calls']} calls")
        for line in broken:
            failures.append("report failed: " + line)
        for key in changed:
            failures.append("output changed: " + key)
        for line in over:
            failures.append(f"more than {BUDGET} backend calls: " + line)

        # The command line still runs from start to finish.
        out_dir = os.path.join(work, "out")
        try:
            done = subprocess.run(
                [sys.executable, "-B", "-m", "nightly", "2031-05-12", "--db", os.path.join(HERE, "db.json"), "--out", out_dir],
                cwd=target, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120,
            )
            written = len(os.listdir(out_dir)) if os.path.isdir(out_dir) else 0
            if done.returncode != 0 or written < 20:
                failures.append(f"python3 -m nightly: exit code {done.returncode}, {written} report files")
        except subprocess.TimeoutExpired:
            failures.append("python3 -m nightly: timed out")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    for line in failures:
        print("FAIL " + line)
    reports = {line.split(": ", 1)[1].split(":")[0].split("/")[1] for line in failures if "/" in line}
    if failures:
        print(f"{len(failures)} checks failed, {len(reports)} of 20 reports affected")
    else:
        print("all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
