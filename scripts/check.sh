#!/bin/zsh
# Every check a mod must pass before a commit: its tests, `plugin validate
# --strict`, a type check, and its own doc and dataset checks (eval/validate.ts)
# when it has them. Also the marketplace manifest, and `plugin validate` again
# with the Claude Code that Claude Desktop carries (it lags the terminal's, and
# Desktop says nothing when it refuses a mod).
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

# The oldest Claude Code each mod asks for (its README's 「要求」). Desktop's own
# Claude Code older than this refusing the mod is a note, not a failure: the
# mod does not run there until Desktop updates. A mod not listed must load in it.
typeset -A MIN_CLAUDE_CODE=(dispatch-pilot 2.1.300)
autoload -Uz is-at-least

# Claude Desktop's own Claude Code: the newest it has fetched (macOS). Empty where there is no Desktop.
desktop_dir="$HOME/Library/Application Support/Claude/claude-code"
desktop_version=$(ls "$desktop_dir" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
desktop_claude=
[[ -n $desktop_version ]] && desktop_claude=(${desktop_dir}/${desktop_version}/*/claude.app/Contents/MacOS/claude(N[1]))

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

# The mod as Claude Desktop's own Claude Code loads it.
desktop_check() {
  local mod=$1 out min=${MIN_CLAUDE_CODE[$1]:-}
  if [[ -z $desktop_claude ]]; then
    print -r -- "skip  $mod: Desktop's Claude Code (none here)"
    return
  fi
  if out=$("$desktop_claude" plugin validate "./$mod" --strict 2>&1); then
    print -r -- "ok    $mod: validate on Desktop's Claude Code $desktop_version"
  elif [[ -n $min ]] && ! is-at-least "$min" "$desktop_version"; then
    print -r -- "note  $mod: Desktop's Claude Code $desktop_version is older than the $min it needs, and refuses it; it runs in Desktop once Desktop updates"
    print -r -- "$out" | awk '/Found [0-9]+ error/ { found = 1; next } found && /❯/ { print; exit }' | cut -c1-240
  else
    print -r -- "FAIL  $mod: validate on Desktop's Claude Code $desktop_version"
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
  desktop_check "$mod"
done
exit $failed
