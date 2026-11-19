# standings

League tables for the Riverside Sunday League, worked out from a plain results file.

```
python3 -m standings data/results-2031.txt
```

## The results file

- `[Division One]` starts a division. The lines after it belong to that division, up to the next
  such line.
- `Harbour Rovers 2-1 Kestrel Park` is one match: home team, home goals, away goals, away team.
- Blank lines and lines that start with `#` are skipped.
- Any other line is an error. The message names the line number and nothing is printed.

## The table

One table per division, in the order the divisions come in the file. A win is worth 3 points and a
draw 1. The columns are the place, the team, then played, won, drawn, lost and points. Teams are
ordered by points; teams level on points are listed alphabetically.

## Layout

- `standings/results.py`: reads the results file into divisions and matches.
- `standings/table.py`: turns the matches of one division into the rows of its table.
- `standings/render.py`: lays the rows out as text.
- `standings/cli.py`: the command line.

## Tests

```
python3 -m unittest discover -s tests
```
