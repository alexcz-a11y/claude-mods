# event-probe

An observer mod for one question: what does the engine send, in what order, when X happens? Each hook logs one `EP#nn` line to the debug log and passes the event on unchanged.

1. Add a hook for the event you are asking about in `hooks/event-probe.mjs` (types: any mod's generated `.claude-plugin/types/claude-code/index.d.ts`).
2. `./run.sh "<prompt>"` for one headless run: `/name args` for a command, plain text for a message. `commands/plugcmd.md` is a plugin markdown command to try (`/event-probe:plugcmd foo`).
3. Write what you measured, with the Claude Code version, into the mod's DEVELOPMENT.md (「已实测的引擎行为」).

It lives under `docs/research/` so `claude --plugin-dir .` never loads it with the repo's mods.
