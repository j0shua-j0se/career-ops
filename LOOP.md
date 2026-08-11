# LOOP.md — the career-ops scan loop

> Loop engineering (github.com/cobusgreyling/loop-engineering): *"Stop prompting.
> Design the loop. Get a score."* The point is not a better prompt — it is that
> the thing which decides **what happens next** stops being a human typing and
> becomes a system with state, budgets, and a gate.
>
> The caveat from the same source applies here in full: **verification is still
> on you.** This file describes what the loop is allowed to do on its own; it
> does not claim the loop is right.

## The loop

`/career-ops scan` is a loop, not a single pass. It runs until it has **10 new
jobs scoring ≥ 3.8**, or until a budget stops it.

```
start ──▶ scan wave ──▶ ingest offers ──▶ dedup ──▶ triage-score batch
             ▲                                          │
             └──────────── not enough yet ◀──────────────┤
                                                         ▼
                                  10 qualified ──▶ tracker rows + dashboard
                                                         ▼
                                              ▶ HUMAN GATE (you review)
                                                         ▼
                                            /career-ops pipeline
```

| Loop-engineering primitive | Where it lives here |
|---|---|
| Durable state (`STATE.md`) | `data/loop-state.json` — survives context loss, compaction, and crashes |
| Run log (`loop-run-log.md`) | `data/loop-run-log.md` — one line per command, append-only |
| Budgets (`loop-budget.md`) | `loop:` block in `config/profile.yml`, enforced by `haltReason()` |
| Constraints (`loop-constraints.md`) | `AGENTS.md` Ethical Use + Data Contract — the loop never relaxes them |
| Gate (`gate.yaml`) | `data/loop-shortlist.md` + your review before `pipeline` |
| Maker | `scan.mjs` / `scan-ats-full.mjs` — zero-token discovery |
| Checker | `modes/triage.md` scoring, ≤ 500 tokens per posting |
| Control law | `loop-core.mjs` — pure, no I/O, unit-tested |
| Driver | `scan-loop.mjs` — the only thing that touches disk |

**The split that makes this work:** the *decision* of what to do next is a pure
function of on-disk state (`decideNextAction`), and the agent only supplies the
one thing a script cannot — a fit score. An agent that is asked both "what next"
and "how good is this" will drift toward declaring itself finished.

## Budgets and halts

Defaults in `loop-core.mjs`, overridable per user under `loop:` in
`config/profile.yml`:

| Key | Default | Meaning |
|---|---|---|
| `target` | 10 | stop once this many **new** candidates clear `minScore` |
| `minScore` | 3.8 | the bar, on the same 0–5 scale as `modes/triage.md` |
| `maxWaves` | 6 | hard cap on discovery waves |
| `maxBarrenWaves` | 2 | circuit breaker: consecutive fully-scored waves yielding nothing |
| `maxScored` | 120 | token-budget proxy — total postings triaged in one run |
| `scoreBatch` | 12 | postings handed to the agent per scoring turn |

A non-finite or non-positive override is ignored rather than applied, so a typo
in `profile.yml` cannot uncap a budget.

The loop halts — honestly short, with `halted_reason` recorded and printed —
when any budget is spent. **It never lowers `minScore` to reach `target`.** A
run that ends with 6 jobs at ≥ 3.8 is a correct run; a run that ends with 10 by
sliding the bar to 3.2 is a broken one.

## Escalation ladder

Each wave widens the search rather than repeating it:

1. `portals` — `scan.mjs` over configured companies/providers (zero-token)
2. `interamt` — `scan-interamt.mjs`, the German public-sector portal (universities, Studierendenwerke, public research). Browser-driven, so slower per posting than an API rung — but far cheaper than sweeping ~38k companies, and in the same institutional neighbourhood as this tracker's highest-scoring rows.
3. `ats-recent` — `scan-ats-full.mjs --since 7`
4. `ats-wide` — `--since 21`
5. `ats-deep` — `--since 45 --include-undated`
6. `agent-web` — `modes/scan.md` Level 1 (Playwright on tracked careers pages) and Level 3 (WebSearch)

Cheapest and most precise first; the agent is the last rung, not the first.

**The order is measured, not assumed.** Tracing every report in `reports/` back
to the portal that surfaced it — exact URL match against `scan-history.tsv` —
the full-ATS rungs produced 5 reports from 717 scanned rows, of which 2
qualified, both at exactly 3.9 and neither built into a kit. Every 4.0+ row came
from a cheap German-market source. That is why the expensive rungs sit late and
why `loop.target` was lowered from 10 to 5: at 10 the loop essentially never
stopped early, so every pass escalated into the sweeps that yield least.

## Dedup

`candidateKey()` normalizes a URL before comparison: strips tracking params
(`utm_*`, `gh_src`, `ref`, `lever-*`, `ashby_jid`, …), the hash, `www.`, and a
trailing slash. The same Greenhouse posting genuinely arrives from `portals.yml`
and from the reverse-ATS sweep with different query strings; without
normalization the loop would "find" it twice and count it toward `target`.

New candidates are also checked against `data/pipeline.md`, the tracker, and
`data/scan-history.tsv` before they count as new.

## Autonomy ladder

| Level | What runs unattended | Status here |
|---|---|---|
| **L1 — report** | discovery, dedup, scoring, shortlist | **the default** |
| **L2 — assisted fixes** | writes `Evaluated` tracker rows so the dashboard shows the run | **on** — reversible, and every row is marked `triage-only … full evaluation pending` |
| **L3 — unattended** | generating and **sending** applications | **off, permanently** |

L3 stays off because of `AGENTS.md` → Ethical Use: *"NEVER submit an application
without the user reviewing it first."* The Gmail sweep in `pipeline` is likewise
L2 at most — it proposes status transitions and only applies the
high-confidence, forward-only ones (see `gmail-sweep.mjs`), leaving everything
else for you.

## Commands

```bash
node scan-loop.mjs start [--target N] [--min-score X] [--reset]
node scan-loop.mjs next                 # what should happen now
node scan-loop.mjs wave [--dry-run]     # run the next discovery rung
node scan-loop.mjs ingest --file offers.json
node scan-loop.mjs record --file scores.json
node scan-loop.mjs finish [--force]     # promote, write tracker rows, merge
node scan-loop.mjs status [--summary]
node scan-loop.mjs abort [--note "..."]
```

The agent drives these; you read `data/loop-shortlist.md`.

## The gate

`finish` writes `data/loop-shortlist.md` and stops. **Nothing downstream runs
automatically.** You review the shortlist, then run `/career-ops pipeline`
yourself. Scores below 4.0 are flagged in the shortlist because Ethical Use
recommends against applying below 4.0/5 — `minScore: 3.8` defines the inbox,
4.0 remains the advice.

## What this loop does not do

- It does not decide a job is a good fit. A triage score is a ≤ 25-word
  first-pass judgement, not the A–F evaluation `/career-ops pipeline` produces.
- It does not verify a posting is live. That is `check-liveness.mjs` at the top
  of `pipeline`, and Playwright at apply time.
- It does not apply to anything, ever.
