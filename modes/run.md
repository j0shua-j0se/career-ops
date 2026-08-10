# Mode: run — The End-to-End Pass

One command for the whole arc: **deep search → evaluate the inbox → build a CV and cover letter for everything that qualifies → reconcile the dashboard.**

Those four things already existed as separate modes. What did not exist was anything that remembered where a pass had got to. A run that died in the middle used to be resumed by the user re-deriving, from memory, which of the four had already happened — and the usual failure was silent: the pass "finished" with a dashboard describing a state that never existed, because the tracker was never merged.

`run` is that memory. It is a **driver-led** mode: you do not decide what happens next, you ask.

## The four stages

| # | Stage | Who does it | What it produces |
|---|-------|-------------|------------------|
| 1 | `scan` | `scan-loop.mjs` (zero-token except its triage steps) | new postings in `data/pipeline.md` |
| 2 | `pipeline` | **you** (`modes/pipeline.md`) | a report + tracker row per URL |
| 3 | `kits` | **you** (`modes/pdf.md` + `modes/cover.md`, via `build-application.mjs`) | a tailored CV **and** cover letter per qualifying row |
| 4 | `sync` | `run-all.mjs sync` (zero-token) | a reconciled tracker, PDF index, follow-up seeds, dashboard |

The order is a data dependency, not a preference. Each stage consumes what the one before it produced.

## Driving it

```bash
node run-all.mjs start        # once per /career-ops run invocation
node run-all.mjs next         # ask what to do; repeat until action = done|halt
```

`next` returns exactly one action:

| Action | What you do |
|---|---|
| `scan` | Run the scan loop: `node scan-loop.mjs next` and do what *it* says, until it reports `finish` or `halt`, then `node scan-loop.mjs finish`. This is `modes/scan.md` in full — load it. When the loop is done, the next `run-all.mjs next` rolls the stage forward on its own. |
| `evaluate` | Load `modes/pipeline.md` and follow it end to end: Gmail sweep, liveness sweep, pre-screen gate, then one evaluation per surviving URL. **Do not build CVs here** — stage 3 does that once every row has a score. |
| `build-kits` | For each row in `candidates`, build the kit (below). |
| `sync` | `node run-all.mjs sync`. Zero tokens; it runs the five reconciliation steps itself. |
| `done` | The pass is complete. Report the summary (below). |
| `halt` | A stage could not clear. Report `reason` to the user plainly and stop. Do not work around it. |

`next` auto-completes any stage whose exit condition is already satisfied, so a pass resumed after a crash — or after another session drained the inbox — rolls straight past what is already done instead of asking you to go and look.

## Stage 3: building the kits

`next` hands you `candidates`: the tracker rows at or above the kit threshold that have no PDF yet. For each one:

1. Read that row's report from `reports/`.
2. Tailor the CV payload (`modes/pdf.md`) and the cover-letter payload (`modes/cover.md`) from it.
3. Run it through the one command that checks liveness first:

```bash
node build-application.mjs --report NNN --cv <cv.json> --cover <cover.json>
```

**Both artifacts, every time.** A CV with no letter leaves the user writing the letter themselves, which is the part they wanted automated. This is the same rule as `modes/pipeline.md` → Application kit.

`build-application.mjs` checks the posting is still open **before** rendering anything and aborts if it is not — a closed posting costs one HTTP round trip instead of two PDFs. If it aborts, do not pass `--skip-liveness` to get around it; mark the row `Discarded` via `set-status.mjs` and move on.

**The kit threshold** is `loop.min_score` from `config/profile.yml` (default `3.8`), falling back to `auto_pdf_score_threshold` only when there is no `loop:` block. One bar decides what the scan loop shortlists and what this stage builds for.

**Between the threshold and 4.0:** build the kit, and say plainly in the summary that `AGENTS.md` → Ethical Use recommends against applying below 4.0/5. The kit existing is not a recommendation to send it.

## Stage 4: what sync actually does

Five steps, in order. The first three are writes; a failure in any of them stops the pass with a non-zero exit, because a later write on top of a failed merge compounds the damage.

| Step | Why |
|---|---|
| `merge-tracker.mjs` | the only sanctioned writer of `data/applications.md`, which is what the dashboard reads |
| `sync-pdf-flags.mjs` | reconciles the tracker's PDF column with what is actually in `output/` |
| `followup-seed.mjs --backfill` | pins a first follow-up date on every row that turned `Applied` |
| `verify-pipeline.mjs` | health check — findings are the user's to act on, so this does not fail the pass |
| `build-dashboard.mjs` | needs a Go toolchain, which is genuinely optional — reported, not fatal |

Then: `npm run serve:dashboard`.

## Rules

- **Never hand-edit `data/run-state.json`.** It is the pass's durable spine; `run-all.mjs` is its only writer.
- **Never skip a stage silently.** `--skip-scan` (and `--skip-pipeline` / `--skip-kits`) are explicit user choices, recorded in the state and shown in `status`.
- **Never work around a `halt`.** It means a stage was attempted `maxStageAttempts` times without clearing. Report it. The user unsticks it with `node run-all.mjs advance --note "..."` or `abort`.
- **Nothing here submits anything.** Every artifact is a draft for the user to review. `AGENTS.md` → Ethical Use holds in full: no form is filled, no message is sent, no Apply button is clicked. This is the mode most likely to be mistaken for "do the whole job search for me" — say so plainly in the summary.
- **Respect the blacklist and the 4.0 guidance.** A high-throughput pass is not a licence to lower the bar; it is a reason to hold it.

If you lose track mid-pass, `node run-all.mjs status --summary` says where it is and `next` says what to do about it. Start a genuinely fresh pass with `start --reset`; abandon one with `abort --note "why"`.

## Final summary

Close the pass with the stage roll-up and the per-application table:

```
Pass {run_id} — {n}/4 stages complete

| # | Company | Role | Score | CV | Cover | Recommended action |
```

Then state, in one line: what was built, what the user must review, and that nothing was sent.
