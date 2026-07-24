# Dense-hex (verbatim-15) — Claude Opus 5 vs Claude Fable 5, 2026-07-24

15 trials, the battery behind the `dense hex (N=15)` column in the model-quality
table. Task per trial: locate the JSON line whose `dur_ms` matches exactly, then
transcribe its 12-hex `id` **visually** from a dense page ("do not use code").
Driven through the Claude Code CLI on session auth, parallelism 3 — same
transport as `eval/verbatim-15/run.sh`, with the model parameterised.

## Result

| model | dense hex | source |
|---|---:|---|
| google/gemini-3.6-flash | 14/15 | published table |
| claude-fable-5 | 13/15 | published table |
| **claude-fable-5** | **12/15** | **this run (control)** |
| **claude-opus-5** | **7/15** | **this run** |
| claude-opus-4-8 | 0/15 | published table |
| gpt-5.6-sol / grok-4.5 / kimi-k3 | 0/15 | published table |

**Opus 5 breaks the zero — 0/15 → 7/15 — but lands well short of Fable.** On the
hardest available probe it recovers under half the strings Fable does. The
one-hex battery in `eval/opus-density/` showed Opus 5 at 4/4 and was simply not
discriminating; this is the test that separates the two.

**Fable at 12/15 against a published 13/15 validates the harness.** That control
is what caught the first attempt: the runner had the prompt after `--model`
rather than directly after `-p`, so every `claude -p` call died with

```
Error: Input must provided either through stdin prompt argument when using --print
```

the `[0-9a-f]{12}` grep matched nothing, and both models scored a clean,
entirely fictitious 0/15. Fable scoring 0/15 is impossible if the harness works,
which falsified the run immediately. The runner now dumps the raw response to
stderr whenever a trial produces no hex, so a silent-empty failure cannot be
scored as a miss again.

## Caveats

- n=1 per trial; no repeats.
- Transport is the CLI's Read tool, not pxpipe's own request-body path.
- Opus 5 is slow here — a single trial exceeded 240s (a trivial `claude -p`
  round-trips in 3.7s), since thinking is on by default and this is a hard
  visual search.

## Reproduce

```sh
verbatim15.sh claude-opus-5 eval/verbatim-15 out.txt   # prompt must follow -p
```
