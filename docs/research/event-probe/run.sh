#!/bin/zsh
# One headless run with the probe loaded; prints the probe's lines in order.
#   docs/research/event-probe/run.sh "/codebase-design just say ok"
# Logs go to $TMPDIR/event-probe/. Interactive runs (origin composer) match -p
# runs in order and payload shape (measured on 2.1.291).
HERE=${0:A:h}
LOGS=${TMPDIR:-/tmp}/event-probe; mkdir -p $LOGS
L=$LOGS/$(date +%s).log
command claude -p "$1" --model haiku --plugin-dir "$HERE" --debug-file $L > $L.out 2>&1
print -r -- "== $1 (exit $?), log $L"
grep -E "EP#" $L | sed -E 's/^.*to debug\): //' | cut -c1-330
