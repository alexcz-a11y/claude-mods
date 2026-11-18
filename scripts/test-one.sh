#!/bin/zsh
# Runs only some test files of a mod: `claude plugin test` takes no filter, so
# the other *.test.ts and *.test.tsx files are parked in a temporary folder and
# put back on exit (also on Ctrl-C).
#
#   scripts/test-one.sh dispatch-pilot command-turns.test.ts [board.test.tsx ...]
set -u
ROOT=${0:A:h:h}
(( $# >= 2 )) || { print -u2 "usage: $0 <mod> <file.test.ts|file.test.tsx>..."; exit 2; }
MOD=$ROOT/$1; shift
[[ -d $MOD/tests ]] || { print -u2 "no tests folder in $MOD"; exit 2; }
for k in "$@"; do [[ -f $MOD/tests/$k ]] || { print -u2 "no such test file: tests/$k"; exit 2; }; done

PARK=$(mktemp -d "${TMPDIR:-/tmp}/test-one.XXXX")
restore() {
  local parked=("$PARK"/*.test.ts(N) "$PARK"/*.test.tsx(N))
  (( $#parked )) && mv $parked "$MOD/tests/"
  rmdir "$PARK"
}
trap restore EXIT INT TERM
for f in "$MOD"/tests/*.test.ts(N) "$MOD"/tests/*.test.tsx(N); do
  (( ${@[(Ie)${f:t}]} )) || mv "$f" "$PARK/"
done
cd "$MOD" && command claude plugin test .
