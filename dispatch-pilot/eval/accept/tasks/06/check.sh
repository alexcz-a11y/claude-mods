#!/usr/bin/env bash
# usage: bash check.sh <directory of the project copy>
# Exit code 0: the task was done correctly. Everything it checks is behaviour seen from outside.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
if [ $# -lt 1 ] || [ ! -d "$1" ]; then
  echo "usage: bash check.sh <directory of the project copy>" >&2
  exit 2
fi
target="$(cd "$1" && pwd)"
export PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8 LC_ALL=C TZ=UTC
unset PYTHONPATH PYTHONSTARTUP NODE_OPTIONS NODE_PATH
exec python3 -B "$here/check/run_checks.py" "$target"
