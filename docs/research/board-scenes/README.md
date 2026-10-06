# board-scenes

A probe for looking at dispatch-pilot's screens (the band, the footer, the rationale pane) with no model or decision request: it answers dispatch-pilot's `$.state` reads of `board`, `decisionLog` and `skillProfiles` with fixed scenes. Turns are not run; the screens draw what the scene holds.

It lives under `docs/research/` so `claude --plugin-dir .` never loads it with the repo's mods. The scenes follow `dispatch-pilot/types/index.d.ts` as of 0.3.1: when the contract changes, update the scene that shows the change.

## Scenes (`/dpscene <name>`, or `DP_SCENE=<name>` at launch)

| Scene | What it shows |
|---|---|
| `agents` (default) | A main turn with dispatched agents: done, running, failed, a long and a Chinese name; mid-turn re-decisions kept, raised, held and blocked; a forced raise; a find_skill failure in the event stream; skill profiles done with one failure |
| `writing` / `stopped` | `agents`, with the skill-profile line 生成中 2/5, or stopped by an API error |
| `workflow` | A Workflow's agents: done, running, and a call not started yet (queued) |
| `notrouted` | The main agent and a dispatched agent not routed, with the failure behind each |
| `idle` | A finished turn: the band's one line, with 可试 /x |
| `many` | 14 agents: more than the digit keys, rows past the band's height |

## Looking at it (iTerm2 + herdr)

1. Open a fresh shell pane next to yours: `herdr pane split <your pane> --direction down` (fullscreen iTerm2: a 194 x 32 pane, where the rationale pane docks on the right at about 76 columns; split it right again for ~97 columns, where the pane goes inline above the prompt).
2. In that shell pane only: `herdr pane run <new pane> "command claude --plugin-dir ./dispatch-pilot --plugin-dir ./docs/research/board-scenes"`. Never `herdr pane run` into a pane where Claude is running: it types the text in as a prompt.
3. Drive it with `herdr pane send-text <pane> "/dpscene workflow"` and `herdr pane send-keys <pane> enter`; `/dp` opens the pane. There is no pagedown: scroll a focused pane with repeated `down`.
4. After a resize, wait 5 to 12 seconds before reading: Claude follows a herdr resize slowly, passing through ~25 and ~52 columns.
5. `python3 docs/research/board-scenes/capture.py herdr <pane> <out_dir> <suffix> <scene>...` switches scenes and saves each screen as `.txt` and `.ansi` (`herdr pane read --format ansi`). `capture.py tmux <session> ...` does the same in a detached `tmux new -x 180 -y 50` (tmux quantizes the colours).
6. Close the panes you opened. Then copy `dispatch-pilot/.claude-plugin/types/` back from the main checkout if you loaded a worktree's mod: loading it regenerated the types from that session, and `tsc` fails on `mcp__dispatch-pilot__find_skill` (`scripts/check.sh` copies them only when they are missing).

Write what you saw, with the Claude Code version and the widths, into dispatch-pilot's DEVELOPMENT.md (「已实测的引擎行为」) when it is a fact about the engine.
