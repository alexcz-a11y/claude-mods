# readlog

A reading list kept in one JSON file.

```
node bin/readlog.mjs list
node bin/readlog.mjs list --status reading
node bin/readlog.mjs add --title "Understory" --author "Kaito Mbeki" --pages 344 --tags nature,essays
node bin/readlog.mjs stats
```

Every command takes `--file <path>` to work on another list than `data/books.json`.

## Commands

- `list` prints one line per book, in the order of the file. `--status to-read|reading|done` keeps
  only the books in that state.
- `add` puts a book at the end of the list. `--title`, `--author` and `--pages` are required;
  `--status` (default `to-read`), `--rating` (1 to 5) and `--tags` (separated by commas) are optional.
- `stats` counts the books, in all and per state.

A command that cannot do what was asked prints `error: ...` on stderr and exits with 1; the file is
left as it was.

## Data

A book is `{ "title", "author", "pages", "status", "rating", "tags" }`. `status` is `to-read`,
`reading` or `done`. `rating` is a whole number from 1 to 5 and is left out until the reader gives
one. `tags` is a list and may be empty; tags are kept the way they were typed.

## Layout

- `bin/readlog.mjs`: the command line.
- `src/cli.mjs`: picks the command, reads the file, prints what the command returns.
- `src/args.mjs`: splits the command line into flags and other words.
- `src/commands/`: one file per command.
- `src/book.mjs`, `src/format.mjs`, `src/store.mjs`, `src/errors.mjs`: shared by the commands.

## Tests

```
node --test
```
