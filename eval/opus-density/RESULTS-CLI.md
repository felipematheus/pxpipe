# Opus 5 vs Fable 5 — density read sweep over the Claude Code CLI (2026-07-24)

Run of `run-cli.mjs`; raw output in `results-cli.json`. Transport is the Claude
Code CLI on session auth (no API key), **not** the direct `/v1/messages` path
`run.mjs` uses — see Transport validity below before comparing to the committed
`RESULTS.md` numbers.

## Result: both models clear the acceptance bar at every density

| variant | page px | img tok | savings | Opus 5 exact | Opus 5 confab | Fable 5 exact | Fable 5 confab | gist | guard |
|---|---|---:|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `5x8` (production) | 1568×128 | 280 | 79% | **4/4** | **0** | **4/4** | **0** | ok | ok |
| `7x10`             | 1562×228 | 504 | 62% | **4/4** | **0** | **4/4** | **0** | ok | ok |
| `9x12`             | 1565×344 | 728 | 45% | **4/4** | **0** | **4/4** | **0** | ok | ok |

Every cell: 4/4 exact, zero confabulations, gist correct, guard correctly
answered "NOT STATED" (1 abstain per cell is the guard, which is the pass state).

**The density ladder is gone.** The committed 2026-07-05 receipt has Opus 4.8
climbing 1/4 → 3/4 → 4/4 with 3 confabulations at production `5x8`. Opus 5 reads
`5x8` perfectly. On this battery Opus 5 is not merely better than Opus 4.8 — it
is at ceiling where 4.8 confabulated three of four exact strings.

Neither model refused the never-stated-password guard here. That differs from
`RESULTS.md`, where the guard tripped Fable's `cyber` classifier 6/6 on the API
path; the CLI's prompt framing evidently doesn't.

## Transport validity — the decoy control

A flat ladder is exactly the signature of a broken transport (an image the model
never really read, or one preprocessed into something else), so the run was
gated on a control before being believed.

A decoy image was rendered at production `5x8` density from the same fixture
with **different secrets** — `f0e1d2c3b4a5` instead of `a3f9c1e0b7d2`, port
`51903` instead of `47821` — written outside the repo, and Opus 5 was asked the
hex question with the same prompt, from the same working directory:

```
ANSWER: "f0e1d2c3b4a5"
```

It returned the value **in the pixels**, not the value baked into
`eval/opus-density/*.mjs` sitting in its own working directory. So:

- the model is genuinely reading the image, not the repo source;
- a novel 12-char hex survives the CLI's Read-tool path at the hardest density;
- the flat ladder is a real ceiling effect, not a transport artifact.

Caveat: the control is n=1, on the hex probe (the discriminating one per the
`DEFAULT_MODEL_BASES` comment, which cites dense-hex as Opus 4.8's failure mode).

## What this does and does not license

**Does not** by itself justify adding `claude-opus-5` to `DEFAULT_MODEL_BASES`
(`src/core/applicability.ts:37`):

- **The battery is now too easy.** Six questions, one 12-char hex. Both models
  max it out, so it cannot rank them or locate Opus 5's actual cliff. The
  exclusion comment cites "Opus 4.8 … 6/15 dense-hex vs Fable 100/100" — a
  15-string probe. This battery has one. Re-run against the harder suites
  (`eval/grok-density/`, `eval/verbatim-15/`) before changing the default.
- **Transport differs from production.** pxpipe images real session history into
  the request body; here the image arrived via the Read tool inside Claude
  Code's own system prompt and tool loop. Confirm on the `run.mjs` path
  (needs an API key) before shipping a default change.
- n=1 per cell.

## Reproduce

```sh
pnpm exec tsx eval/opus-density/run-cli.mjs --models claude-opus-5,claude-fable-5
```

~36 `claude -p` invocations, ~16 min, ~$7.50 of list-price-equivalent session
usage (subscription auth — nothing billed per token).
