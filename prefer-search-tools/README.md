# prefer-search-tools

In auto mode (and bypass mode), Claude Code adds a reminder for the model. It tells the model to do much of its work in the Bash tool, including "search with grep and find". This mod changes **only that clause**: it removes the clause and adds one sentence at the end of the reminder, so the model searches file contents with the Grep tool and file names with the Glob tool. The rest of the reminder (reading files with cat/head, editing files with sed, and so on) is left exactly as the engine wrote it.

- Event: `prompt.attachment`, matched on `{ type: 'auto_mode' }`. It does not touch the system prompt, the auto-mode classifier, or any other reminder.
- If a future version rewords the clause, the mod finds nothing to replace and passes the reminder through unchanged.
- It assumes Grep/Glob are in the session's tool set. On macOS/Linux they are absent by default, so start with `--allowedTools=Glob` or `--tools`. Naming either one in `--allowedTools` brings both back.
- The engine decides a reminder's text once per process. After installing, the mod takes effect in a new session.

```bash
claude --plugin-dir ./prefer-search-tools        # load for this session
command claude plugin test ./prefer-search-tools
```

**Tested with Claude Code 2.1.296.** In an interactive auto-mode session, the debug log shows `prompt.attachment auto_mode: … rewrote it (479 -> 568 characters)`. In `-p` mode the engine does not send this reminder at all.
