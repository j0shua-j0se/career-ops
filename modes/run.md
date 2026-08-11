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
| `scan` | Run the scan loop: `node scan-loop.mjs next` to see what is due, then **`node scan-loop.mjs wave`** to actually run it — repeat until `next` reports `finish` or `halt`, then `node scan-loop.mjs finish`. **Never run `strategy.command` yourself.** `next` prints it so you know what is coming; only `wave` snapshots the inbox, records the rung and advances the state. Running the strategy by hand scans for real and leaves the counters untouched, so `next` returns the same wave forever — a loop that never terminates while looking busy. This is `modes/scan.md` in full — load it. **Then sweep the agent-driven sources below** — the loop cannot reach them. When both are done, the next `run-all.mjs next` rolls the stage forward on its own. |
| `evaluate` | Load `modes/pipeline.md` and follow it end to end: Gmail sweep, liveness sweep, pre-screen gate, then one evaluation per surviving URL. **Do not build CVs here** — stage 3 does that once every row has a score. **Every pre-screen discard must be marked `- [x]` in Processed, not merely logged** — see below. |
| `build-kits` | For each row in `candidates`, build the kit (below). |
| `sync` | `node run-all.mjs sync`. Zero tokens; it runs the five reconciliation steps itself. |
| `done` | The pass is complete. Report the summary (below). |
| `halt` | A stage could not clear. Report `reason` to the user plainly and stop. Do not work around it. |

`next` auto-completes any stage whose exit condition is already satisfied, so a pass resumed after a crash — or after another session drained the inbox — rolls straight past what is already done instead of asking you to go and look.

## Stage 1b: the sources the scan loop cannot reach

Several high-value sources have no zero-token HTTP provider and never will. They
produced **zero** jobs for months despite being `enabled: true` in `portals.yml`,
because the agent had nowhere to put what it found. `ingest-jobs.mjs` is that
landing pad — it dedups against `data/scan-history.tsv` *and* the inbox,
canonicalises URLs (stripping `utm_*`/`fbclid`/`refid`/`eid`), and writes rows in
the shape `scan.mjs` uses, so the prefilter, liveness sweep and pipeline stage
read them unchanged.

Collect `{url, company, title, location?, postedAt?}` into a JSON array, then:

```bash
node ingest-jobs.mjs --file offers.json --source <label>
```

**This stage is now enforced, not remembered.** When the scan loop finishes,
`run-all.mjs next` returns `scan-agent-sources` and will NOT complete the stage
until you record the sweep with `node run-all.mjs note-sources --note "..."`.
That exists because the omission was silent: an Indeed sweep that legitimately
finds nothing writes exactly what a sweep that never ran writes, so a pass could
report "scan complete" having never touched it. Record it even when you skip
deliberately — the note is the audit trail.

| Source | How | Verified |
|---|---|---|
| **Indeed** | the Indeed MCP `search_jobs` (needs `search`, `location`, `country_code: "DE"`). Not a `providers/` module and never can be — the MCP is a tool only the agent can call, Indeed publishes no public job API, and the RSS feed returns 403. | ✅ found a Siemens Healthineers Werkstudent in Forchheim |
| **StepStone** | **Automated — no longer a Stage 1b step.** `providers/stepstone.mjs` runs in wave 1 with every other board, shelling out to the `scrapling` CLI (StepStone has no usable API; `/public-api/` is robots-Disallowed and a plain fetch is refused). Needs `scrapling` on PATH. | ✅ 25 cards/page parsed, company + location + date |
| **BMW** | **Do not scrape it.** `bmwgroup.jobs` runs Akamai Bot Manager: the shell returns 200 but the job-search component never initialises for an automated client, so there is no API call to intercept. Its SuccessFactors instance is the RCM application portal, not the public RMK board `providers/successfactors.mjs` reads. BMW arrives through the **Arbeitsagentur — BMW Group** board instead. | ✅ 16 found, 1 queued |
| **LinkedIn** | Not supported. Reaching it needs the user's `li_at` session cookie — a credential — and breaches LinkedIn's ToS with real account-restriction risk against a profile that is a live asset in this search. Do not build it without an explicit, informed instruction. | — |

**Arbeitsagentur is the highest-yield source and the least fought-over.** It is
the federal job database, every German employer posts there as routine, and it
reaches BMW, Siemens, Bosch and Schaeffler without credentials. When a source
looks unreachable, check whether Arbeitsagentur already carries it before
building a scraper.

## Stage 2: pre-screen discards must be marked, not just logged

`modes/pipeline.md` requires every posting the pre-screen gate drops to be both
logged to `data/discard.log` **and** marked `- [x] #-- | {url} | skipped
(pre-screen mismatch: {reason})` in Processed. Logging alone is not enough and
the failure is silent: a pass once logged 47 discards without marking them, so
the same 47 stayed `- [ ]`, were re-discarded on every later run, duplicated
their log lines, and kept the inbox permanently inflated at 60 pending when the
real figure was 13.

If `next` keeps reporting the same pending count after an evaluation pass, this
is why.

## Stage 3: building the kits

`next` hands you `candidates`: the tracker rows at or above the kit threshold that have no PDF yet. For each one:

1. Read that row's report from `reports/`.
2. Tailor the CV payload (`modes/pdf.md`) and the cover-letter payload (`modes/cover.md`) from it.
3. Run it through the one command that checks liveness first:

```bash
node build-application.mjs --report NNN --cv <cv.json> --cover <cover.json>
```

**Both artifacts, every time.** A CV with no letter leaves the user writing the letter themselves, which is the part they wanted automated. This is the same rule as `modes/pipeline.md` → Application kit.

### Rows held back: `needsDecision`

`next` returns two lists. `candidates` are safe to build. **`needsDecision` are rows whose own report says not to send them** — "DO NOT APPLY", "do NOT apply as posted", "send a one-question enquiry instead".

Score cannot see this. ZEISS and Manex both scored 3.9, above the bar, while their reports said full-time against a 20 h/week cap, and Munich at ~190 km, and asked for an enquiry rather than an application. **Do not build these unprompted** — surface them to the user with the report's reason and let them decide. If the user overrides and asks for the kit anyway, build it, but write the letter so it *acknowledges* the blocker and proposes the accommodation. A letter that reads as though the candidate had not noticed a full-time contract or a 190 km commute is worse than none.

### When liveness aborts

`build-application.mjs` checks the posting is still open **before** rendering anything and aborts if it is not — a closed posting costs one HTTP round trip instead of two PDFs.

**Do not reach for `--skip-liveness` reflexively.** But the checker has known false negatives, and all three cost a real build this session:

| Symptom | Cause | What to do |
|---|---|---|
| "content present but no visible apply control found" | the posting **applies by email** and legitimately has no Apply button | confirm the contact address is in the JD, then `--skip-liveness` |
| `uncertain` on a JS-rendered portal | anti-bot 403, or a blocked third-party request (SAP fetches an internal VPN host) | re-verify by browser, then `--skip-liveness` |
| the checker lands on a careers homepage | the report's `**URL:**` header is a portal root, not a deep link | **fix the header** — `readReportUrl` takes only the first whitespace-delimited token |

Verify by hand *before* overriding, and say in the summary which rows were overridden and why. If the posting is genuinely closed, mark the row `Discarded` via `set-status.mjs` and move on.

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
