# career-ops project map (reference)

> **Reference only.** Every rule (Data Contract, Source-of-Truth Boundary, Untrusted External Content, Ethical Use, Offer Verification, Pipeline Integrity, ...) lives in `AGENTS.md`, which every session loads. This file holds the material that is looked up, not obeyed: the Codex invocation notes, the file/script catalog, the first-run onboarding walkthrough and the CI/governance notes. `AGENTS.md` says when to read it. Nothing here overrides `AGENTS.md`.

## Contents

1. [Codex invocation](#codex-invocation)
2. [Main files and scripts](#main-files-and-scripts)
3. [First-run onboarding walkthrough (Steps 0-6)](#first-run-onboarding-walkthrough)
4. [CI/CD, community and governance](#cicd-community-and-governance)

### Codex invocation

- **Interactive:** run `codex` in the repo root; if `/career-ops` is unavailable, ask Codex to run the mode directly.
- **Headless:** `codex exec "prompt"` for one-shot workers.
- **Examples:** `Run career-ops scan mode`, `Run career-ops pipeline mode for data/pipeline.md`, `Run career-ops pdf mode`, `Run career-ops tracker mode`, `Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123`

## Main files and scripts

| File | Function |
|------|----------|
| `data/applications.md` | Application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/run-state.json` | End-to-end pass state, written only by `run-all.mjs` |
| `data/scan-history.tsv` | Scanner dedup history |
| `data/scan-runs.tsv` | Per-run scan counters (appended by `scan.mjs`, read by `stats.mjs`) |
| `data/follow-ups.md` | Follow-up history tracker |
| `data/blacklist.md` | Do-not-apply companies (user layer, opt-in, never auto-populated; respected by `scan.mjs` and the `auto-pipeline`/`oferta`/`apply` gates) |
| `data/salary-observations.tsv` | Append-only salary observation log (user layer) |
| `data/assessments.tsv` | Append-only skills-assessment log (user layer, created on first `add`) |
| `portals.yml` | Query and company config |
| `templates/cv-template.html` | HTML template for CVs |
| `templates/cv-template.tex` | LaTeX/Overleaf template for CVs |
| `article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories |
| `interview-prep/{company}-{role}.md` | Company-specific interview intel |
| `generate-pdf.mjs` | Playwright: HTML to PDF |
| `generate-latex.mjs` | LaTeX CV validator + pdflatex compiler |
| `scan.mjs` | Zero-token portal scanner (Greenhouse/Ashby/Lever APIs, zero LLM cost) |
| `scan-ats-full.mjs` | Reverse-ATS keyword-first scanner over full public ATS datasets (Greenhouse/Lever/Ashby/Workday/iCIMS), filtered by portals.yml `title_filter`/`location_filter` and then a reach gate (`sweepReachGate` in `triage-prefilter.mjs`: home, Munich, or remote scoped to Germany/EU/Europe/DACH/EMEA — a bare "Remote" is dropped; `--no-reach-gate` opts out) — no company list needed; checkpoints every 500 companies, `--resume` continues an interrupted sweep |
| `scan-interamt.mjs` | Playwright browser scanner for Interamt.de (German public sector portal — Apache Wicket, no REST API) |
| `scan-loop.mjs` / `loop-core.mjs` | The scan loop: `/career-ops scan` keeps widening the search until it has 10 NEW postings scoring >= `loop.min_score` (3.8) or a budget stops it. `loop-core.mjs` is the pure control law (no I/O, unit-tested); `scan-loop.mjs` is the only thing that touches disk. State in `data/loop-state.json`, audit trail in `data/loop-run-log.md`, human review gate in `data/loop-shortlist.md`. See `LOOP.md` |
| `gmail-sweep.mjs` | Non-interactive reply sweep run as Step 0 of `/career-ops pipeline`: `query` scopes a Gmail search to companies actually in flight, `plan` classifies + matches fetched messages, `apply` writes the high-confidence, forward-only transitions through `set-status.mjs`. Never touches the mailbox itself and never sends anything |
| `run-all.mjs` / `run-core.mjs` | **The end-to-end pass** behind `/career-ops run`: deep search -> evaluate the inbox -> a tailored CV **and** cover letter per qualifying row -> reconcile the tracker/PDF index/follow-ups/dashboard. `run-core.mjs` is the pure stage control law (no I/O, unit-tested); `run-all.mjs` is the only thing that touches disk. Durable state in `data/run-state.json` so a crashed pass resumes where it stopped; audit trail in `data/run-log.md`. Stages 1 and 4 are zero-token; 2 and 3 are handed back to the agent with an explicit contract. Never submits anything. See `modes/run.md` |
| `LOOP.md` | Loop design: budgets, escalation ladder, dedup, the L1/L2/L3 autonomy ladder, and what the loop is not allowed to do |
| `audit-portals.mjs` | Content audit of `portals.yml` — the companion to `verify-portals.mjs`, which answers "does this board answer?" but never "*whose* postings are these?". Fetches each enabled board through the same `providers/` modules `scan.mjs` uses and reports provider + posting count + sample titles/locations per entry, verdicts worst-first: `no-provider` (enabled but nothing claims it, so `scan.mjs` skips it silently — the highest-value check), `error`, `empty`, `small`, `ok`. `--baseline prev.json` compares against an earlier `--json` run and flags boards that lost ≥50% of their postings, the shape an ATS migration takes. **It cannot detect a well-formed board belonging to the wrong entity** — a parent company's board is full of real jobs — so it surfaces the evidence a reader needs instead of pretending to a verdict (JSON, `--summary`, `--strict`) |
| `check-liveness.mjs` / `liveness-core.mjs` | Job posting liveness checker + shared logic (expired signals win over generic Apply text) |
| `fetch-jds.mjs` | Zero-token JD pre-fetcher for `scan-loop.mjs`'s `score` step: ATS API first, then robots/egress guard, then a plain HTTP read for hosts measured to need no browser (StepStone), then Playwright; compacted to `{key, url, company, title, location, status, liveness, chars, text}` JSON so one triage worker scores a whole batch from a local file instead of WebFetch/browser per posting. `--gate-out`/`--rest-out` split off the verdicts that need no model — expired, not fetchable, and a fluent-tier German requirement (`germanHardStop`, quoted verbatim) — as ready-to-record TRIAGE lines, so only the rest reaches a worker |
| `fetch-jd.mjs` | JD text from a known ATS API (Greenhouse/Lever/Ashby/Workday — `liveness-api.mjs`'s `JD_TEXT_API_ATS`), no browser needed. Prints the JD on stdout and exits 0 on a hit; exits 1 with empty stdout otherwise, so the caller's existing browser/WebFetch fallback is the next step. Backed by `browser-extract.mjs`'s `fetchJdViaKnownApi()`, the same dispatch its `jd` mode uses |
| `prescan.mjs` | Unattended, zero-token weekly prescan: `scan.mjs` → `scan-ats-full.mjs --since 7` (honouring `config/profile.yml` `loop.skip_strategies`/`loop.ats_sources`, `--resume` when a checkpoint exists) → `triage-prefilter.mjs --mark-skips --write` → `fetch-jds.mjs` into `data/cache/prescan-jds.json`, marking expired rows processed in `data/pipeline.md`. Refuses to start while a pass is running or another prescan holds the lock. Never evaluates, builds a kit, or touches the tracker. Summary in `data/cache/prescan-summary.json`, audit trail in `data/prescan-log.md`. Registered weekly via `scripts/register-prescan-task.ps1`; `scripts/prescan-status.ps1` shows last/next run |
| `set-status.mjs` | Canonical tracker-row update: `node set-status.mjs <report#\|company> <State> [--note] [--force]` — strict states.yml validation, report-link mismatch guard, shared lock, atomic write. `--row`/`--report` accept a comma list (`--report 3,5,6`) and fan out to one guarded atomic write per row |
| `invite-match.mjs` | Fuzzy-match a pasted interview invite (company, date, req ID) against the tracker, ranking candidates when a company has multiple entries (JSON or `--summary`) |
| `paste-reply.mjs` | Manual/no-Gmail input into reply-watch classification — normalizes a pasted/file email (subject/from/body) and appends to `data/reply-candidates.json`; never overwrites entries, never classifies, never touches the tracker |
| `analyze-patterns.mjs` | Pattern analysis incl. per-ATS-vendor advance rate (JSON) |
| `upskill.mjs` | Weighted skill-gap map from tracked reports; known skills from `cv.md`/`config/profile.yml` excluded (JSON) |
| `stats.mjs` | Lifetime pipeline stats: tracker roll-up, canonical `ever*` funnel, scan totals, portal coverage, follow-up compliance, scan-run trends (JSON or `--summary`) |
| `data/status-log.tsv` | Append-only status transition ledger, sibling of the tracker file: `{tracker#}\t{date}\t{from}\t{to}\t{source}\t{note}`. Appended by `set-status.mjs` on every real status change; the tracker stays the source of truth for *state*, the ledger records *when*. An unknown from/to state is the sentinel `-`, and the source column is a closed set whose members are `VALID_SOURCES` in `funnel-velocity.mjs` — see `DATA_CONTRACT.md` before writing to it from anywhere else |
| `funnel-velocity.mjs` | Funnel calibration vs market benchmarks + stage velocity, folded from `data/status-log.tsv` (JSON or `--summary`) |
| `company-history.mjs` | Read-only per-company evidence card joining the tracker, follow-ups, scan history and the status-log (JSON or `--summary`) |
| `followup-cadence.mjs` | Follow-up cadence calculator (JSON) |
| `followup-seed.mjs` | Seeds `data/follow-ups.md` with a pinned first follow-up date when a row turns Applied. Takes one appNum, a comma list (`3,5,6` — only those rows, one lock, one write), or `--backfill` for the whole tracker (JSON) |
| `build-application.mjs` | One command per application: liveness check → `build-cv-html.mjs` → `clean-artifacts.mjs` → `verify-cv-facts.mjs` → `generate-pdf.mjs` → `clean-artifacts.mjs` → `generate-cover-letter.mjs` → `clean-artifacts.mjs`, aborting on the first failure. The liveness check runs FIRST and logs to `data/liveness-log.tsv`, so a closed posting costs one HTTP round trip instead of two PDFs. Never submits anything |
| `clean-artifacts.mjs` | Document hygiene for anything a recruiter receives: strips invisible/format Unicode (zero-width, BOM, soft hyphen, bidi controls, tag chars) and normalizes space homoglyphs to ASCII spaces in text, and blanks the `/Creator` + `/Producer` toolchain fingerprint Chromium stamps into every PDF it prints. PDF edits are byte-length preserving so the xref table stays valid. Load-bearing invisibles (emoji ZWJ sequences, emoji/CJK variation selectors, joining-script ZWNJ) are reported but never removed. Runs on the CV **HTML before the fact gate** — an invisible character inside a metric hides it from `verify-cv-facts.mjs` but not from the reader — and on each PDF after render. `--inspect` reports without changing anything; `--skip-clean` on `build-application.mjs` opts out. Logic ported from the MIT-licensed [watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover) |
| `detect-reposts.mjs` | Flags roles re-listed 2+ times in 90 days from `scan-history.tsv` — requires 2+ distinct URLs seen on 2+ distinct scan dates (`--min-span`) with the same title identity, so concurrent per-city/country/segment openings are not mistaken for reposts (JSON or `--summary`) |
| `check-table-freshness.mjs` | Staleness validator for jurisdiction data tables — flags `expired` rows (past `next_effective` without re-verification, exit 1) and `review-due` rows (`as_of` older than 12 months, soft); discovers any `templates/*.yml` with `as_of` rows automatically (JSON or `--summary` table output) |
| `process-quality.mjs` | Per-company recruiting-friction rate from `[process-friction]` tags in `data/active-interviews.md` Notes (JSON or `--summary`) |
| `rejection-latency.mjs` | Post-interview response-latency signal — flags companies still in `Interview` state whose silence since the last `data/active-interviews.md` round exceeds a courtesy (30d default, configurable) threshold, with a ready-to-copy `data/blacklist.md` suggestion row; suggestion-only, never writes (JSON or `--summary` table output) |
| `tracker-sync-check.mjs` | Status-drift checker between `data/applications.md` and `data/active-interviews.md` — matches rows via a `#N in tracker` Notes reference or fuzzy Company+Role, then two-tier resolves mismatches (auto-tier1 via canonical lifecycle order, needs-review-tier2 via `git blame` timestamps). Read-only/reporting in this version — does not write status fixes. Wired into `verify-pipeline.mjs`'s health check. |
| `salary-gap.mjs` | Desired/advertised/actual comp gap analyzer — folds report `advertised_comp` + `data/salary-observations.tsv` (JSON or `--summary`) |
| `negotiation-roi.mjs` | Salary-negotiation talking-point generator — anchors an ask in a quantified `interview-prep/story-bank.md` achievement, kept only if the same number also appears verbatim in `cv.md` (v1 safety gate), converted to an estimated annualized dollar value from an explicit wage/frequency input (never guessed); read-only, draft-only (JSON or `--summary`) |
| `assessment-log.mjs` | Skills-assessment logger — `add` appends platform/subject/threshold/score + staleness note to `data/assessments.tsv` (JSON or `--summary`) |
| `jd-skill-gap.mjs` | Zero-LLM JD skill classifier vs `cv.md`: existing / supportedByResume / gap; never auto-adds claims to `cv.md` (JSON or `--summary`) |
| `contacts.mjs` | Job-search phonebook → vCard 3.0 exporter — stable UIDs so re-imports update instead of duplicating on platforms that honor vCard UID (JSON, `--summary`, `--vcf`, `--caller-id`) |
| `linkedin-join.mjs` | Warm-intro finder — joins a LinkedIn `Connections.csv` export against tracker + `portals.yml` companies to answer "do I know anyone here?"; zero-token, offline, read-only. Operational only: never a scoring input, never a content source (JSON, `--summary`, `--company <name>`, `--tsv`) |
| `data/contacts.tsv` | Job-search contact list — recruiters/hiring managers/peers saved from `contacto` (user layer, gitignored third-party PII) |
| `data/Connections.csv` | LinkedIn connections export (user layer, gitignored third-party PII; read by `linkedin-join.mjs`, safe to delete after use) |
| `outcome.mjs` | Record application outcome, archive artifacts, and sync tracker (`node outcome.mjs <selector> <type>`) |
| `hired-share.mjs` | Draft a Hired Wall story from the tracker and open a prefilled GitHub issue the user submits themselves; `--status` lists hires never asked; `--mark` records their answer permanently |
| `jd-capture.mjs` | Resolves an archived JD in `jds/` by report number, matching padded and unpadded prefixes (`064-`, `64-`, `01-`). Consumed by `outcome.mjs`; written by `archive-posting.mjs --report=N`. Replaces rebuilding a capture's filename from today's date, which stopped resolving the next day |
| `run-retro.mjs` | Zero-token post-pass review: per-source found/new/free-rejected/triaged/qualified/evaluated/kit/applied plus stage timings, from files already on disk (`data/run-log.md`, `data/loop-state.json`, `data/scan-history.tsv`, `data/discard.log`, `reports/`, `data/pdf-index.tsv`, the tracker). `--run <id>` for an older pass, `--all` to backfill, `--summary`/`--json`. Wired into `run-all.mjs sync` as a non-fatal step; idempotent per run_id in `data/run-retro.tsv` |
| `weekly-digest.mjs` | Rolls up `interview-prep/sessions/*.md` (default: current ISO week) into a per-company round summary, recurring competency-tag counts, and best-effort recurring 🔴 gaps from `question-bank.md` (JSON or `--summary`) |
| `reports/` | Evaluation reports `{###}-{company-slug}-{YYYY-MM-DD}.md` — Blocks A-F + G (Posting Legitimacy) + Risk Summary + `## Machine Summary` YAML; header includes `**Legitimacy:** {tier}`; **REQUIRED:** a `## Job Description (archived verbatim)` section with the JD's verbatim text, or an equivalent `jds/` capture (#2789) |
| `check-jd-archive.mjs` | Validates every `reports/*.md` has an archived JD — an embedded `## Job Description` section with substantive content, or a matching `jds/` capture resolved by report number via `jd-capture.mjs`; flags `missing-jd-archive`; read-only (JSON or `--summary` table output) |

## First-run onboarding walkthrough

Entered from `AGENTS.md` → "First Run — Onboarding" when `node doctor.mjs --json` reports `onboardingNeeded: true`. Do NOT proceed with evaluations, scans, or any other mode until the basics are in place. Guide the user step by step:

### Step 0: Free Tier Check

Only if the user mentions cost, pricing, budget, or free alternatives:
> "career-ops works fully on Antigravity CLI's free tier — no API key or paid subscription needed. See [FREE_TIER.md](docs/FREE_TIER.md) for setup, daily limits, and batch tips."

If the user is already on a paid plan (Claude Max, Google AI, etc.) or does not mention cost, skip this step silently.

### Step 1: CV (required)
If `cv.md` is missing, ask:
> "I don't have your CV yet. You can either:
> 1. Paste your CV here and I'll convert it to markdown
> 2. Paste your LinkedIn URL and I'll extract the key info
> 3. Tell me about your experience and I'll draft a CV for you
>
> Which do you prefer?"

Create `cv.md` from whatever they provide — clean markdown with standard sections (Summary, Experience, Projects, Education, Skills).

### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
> - How much do you want to spend on model usage per evaluation? Three options:
>   - **economy** — cheapest and fastest, good for scanning lots of offers quickly
>   - **standard** — balanced cost and quality (default if you're not sure)
>   - **premium** — most capable model, best for offers you really care about
>
> I'll set everything up for you."

Fill in `config/profile.yml` (including `spend_tier`, default `standard`). Archetypes and targeting narrative go to `modes/_profile.md` or `config/profile.yml` — never `modes/_shared.md`.

### Step 3: Portals (recommended)
If `portals.yml` is missing:
> "I'll set up the job scanner with 45+ pre-configured companies. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `portals.yml`; if they gave target roles in Step 2, update `title_filter.positive`.

### Step 4: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

### Step 5: Get to know the user (important for quality)

After the basics, proactively ask for more context:
> "The basics are ready. But the system works much better when it knows you well. Can you tell me more about:
> - What makes you unique? What's your 'superpower' that other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people, no Java shops)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?
>
> The more context you give me, the better I filter. Think of it as onboarding a recruiter — the first week I need to learn about you, then I become invaluable."

Store insights in `config/profile.yml` (narrative), `modes/_profile.md`, or `article-digest.md` (proof points) — never in `modes/_shared.md`.

### Step 6: Ready
Once all files exist, confirm:
> "You're all set! You can now:
> - Paste a job URL to evaluate it
> - Run the scan entrypoint for your CLI to search portals: `/career-ops scan`, `/career-ops-scan`, or ask Codex to run `scan`
> - Open the command menu for your CLI: `/career-ops`, the CLI-specific alias, or ask Codex to show the available career-ops modes
>
> Everything is customizable — just ask me to change anything.
>
> Tip: Having a personal portfolio dramatically improves your job search. If you don't have one yet, the author's portfolio is also open source: github.com/santifer/cv-santiago — feel free to fork it and make it yours."

Then suggest automation:
> "Want me to scan for new offers automatically? I can set up a recurring scan every few days so you don't miss anything. Just say 'scan every 3 days' and I'll configure it."

If the user accepts, use the `/loop` or `/schedule` skill (if available) to set up a recurring scan entrypoint for their CLI (`/career-ops scan`, `/career-ops-scan`, or the equivalent Codex prompt). If those aren't available, point them to [docs/AUTOMATION.md](docs/AUTOMATION.md) for copy-paste cron / launchd / Windows Task Scheduler recipes plus a zero-token triage-to-shortlist prompt, or remind them to run the scan mode periodically.

(The "After every evaluation, learn" rule that follows Step 5 lives in `AGENTS.md`, so it is loaded in every session.)

## CI/CD, community and governance

- **GitHub Actions** on every PR: the full `test-all.mjs` suite, risk-based auto-labeler (🔴 core-architecture, ⚠️ agent-behavior, 📄 docs), first-timer welcome bot. **Branch protection** on `main`: status checks required, no direct pushes (except admin bypass). **Dependabot** on npm/Go/Actions.
- **Contributing:** issue first → discussion → PR with linked issue → CI passes → maintainer review → merge.
- **Governance:** BDFL with contributor ladder (Participant → Contributor → Triager → Reviewer → Maintainer, see `GOVERNANCE.md`) · Contributor Covenant 2.1 (`CODE_OF_CONDUCT.md`) · private vulnerability reporting (`SECURITY.md`) · help questions → Discord/Discussions, not issues (`SUPPORT.md`) · Discord: https://discord.gg/8pRpHETxa4
