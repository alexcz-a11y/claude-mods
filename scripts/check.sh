#!/bin/zsh
# Every check a mod must pass before a commit: its tests, `plugin validate
# --strict`, a type check, and its own doc and dataset checks (eval/validate.ts)
# when it has them. Also the marketplace manifest.
#
#   scripts/check.sh               every mod (each folder with .claude-plugin/plugin.json)
#   scripts/check.sh dispatch-pilot  one mod
#
# Exits 1 when any check fails. The pre-commit hook (.githooks/pre-commit) runs it.
set -u
ROOT=${0:A:h:h}
cd "$ROOT" || exit 1

if (( $# > 0 )); then
  mods=("$@")
else
  mods=(${(f)"$(for f in */.claude-plugin/plugin.json(N); do print -r -- ${f%%/*}; done)"})
fi

failed=0
step() {
  local label=$1; shift
  local out
  if out=$("$@" 2>&1); then
    print -r -- "ok    $label"
  else
    print -r -- "FAIL  $label"
    print -r -- "$out" | tail -40
    failed=1
  fi
}

step "marketplace manifest" command claude plugin validate .
for mod in $mods; do
  step "$mod: tests" command claude plugin test "./$mod"
  step "$mod: validate --strict" command claude plugin validate "./$mod" --strict
  if [[ -f $mod/tsconfig.json ]]; then
    # The generated types are gitignored, so a fresh worktree has none: take the main checkout's.
    main=${${(f)"$(git worktree list --porcelain)"}[1]#worktree }
    if [[ ! -d $mod/.claude-plugin/types && $main != $ROOT && -d $main/$mod/.claude-plugin/types ]]; then
      cp -R "$main/$mod/.claude-plugin/types" "$mod/.claude-plugin/types" && print -r -- "note  $mod: copied .claude-plugin/types from $main"
    fi
    if [[ -d $mod/.claude-plugin/types ]]; then
      step "$mod: tsc" tsc -p "./$mod" --noEmit
    else
      print -r -- "FAIL  $mod: tsc has no types: load the mod once with --plugin-dir to generate .claude-plugin/types"
      failed=1
    fi
  fi
  [[ -f $mod/eval/validate.ts ]] && step "$mod: eval/validate.ts" node "$mod/eval/validate.ts"
done
exit $failed
