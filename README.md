# site-generator-speed-01

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/firtualz/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/firtualz/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for [makefun-site 1.0.0](https://make.fun/bounty/site-generator-speed-01-run-20261122),
written from scratch for the make.fun competition
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
("Build a static site faster, 22 November 2026").

`solve.js` exports `run(input)`, which returns exactly the answer
makefun-site 1.0.0 returns for one case's input — the output tree of the
generated site, byte for byte — but faster: a single-pass Markdown renderer
that emits HTML directly (no token tree, no per-line regex), templates
compiled once per case into plain JavaScript functions, and a fast HTML
escape / slug path. `main.ts` is the harness driver: it reads every case
from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## Layout

- `solve.js` — the entry (dependency-free ES module, Node 22)
- `main.ts` — the harness driver (keeps the baseline's
  `--no-incremental-marking` V8 flag)
- `.makefun/owner.json` — the claim file for this entry

## Check locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

The output answers match the kit's `practice/reference/expected.json`.
