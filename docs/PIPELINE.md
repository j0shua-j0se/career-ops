# The pipeline

What `/career-ops run` actually does, and where every gate sits.

Four stages, in dependency order. Each consumes what the one before produced —
the order is a data dependency, not a preference. Stages 1 and 4 cost **zero
tokens**; 2 and 3 need a model and are handed back to the agent with an explicit
contract.

![Pipeline](pipeline.svg)

```mermaid
flowchart TD
    subgraph S1["STAGE 1 · scan — zero-token"]
        A1[scan.mjs<br/>portals + providers] --> F1
        A2[scan-interamt.mjs<br/>public sector] --> F1
        A3[scan-ats-full.mjs<br/>reverse-ATS sweep] --> F1
        A4["Stage 1b · agent<br/>Indeed MCP → ingest-jobs.mjs"] --> F1
        F1{{"title_filter<br/>location_filter<br/>blacklist · trust-validator"}}
        F1 --> H1{{"scan-run-health<br/>starved scan ≠ empty market"}}
        H1 --> P1{{"triage-prefilter<br/>skip → auto-reject, zero tokens"}}
    end

    P1 --> INBOX[("data/pipeline.md<br/>data/scan-history.tsv")]

    subgraph S2["STAGE 2 · pipeline — agent"]
        INBOX --> G0[gmail-sweep<br/>reconcile the mailbox]
        G0 --> LV{{"check-liveness<br/>robots-gate · fetchableUrl"}}
        LV --> PS{{"pre-screen gate<br/>→ data/discard.log"}}
        PS --> EV[evaluation<br/>Blocks A–G]
        EV --> REP[("reports/NNN-*.md<br/>Machine Summary")]
    end

    REP --> MT[merge-tracker] --> TRK[("data/applications.md")]

    subgraph S3["STAGE 3 · kits — agent"]
        TRK --> KC{{"kitCandidates<br/>≥ floor · has report · no PDF"}}
        KC --> LG{{"language gate<br/>language_gate: FAIL → stop"}}
        LG --> BA["build-application.mjs"]
        BA --> C1[liveness] --> C2[build-cv-html] --> C3[clean-artifacts]
        C3 --> C4[verify-cv-facts] --> C5[generate-pdf] --> C6[clean-artifacts]
        C6 --> C7{{"verify-pdf-ats<br/>text layer + page count"}}
        C7 --> C8[cover letter] --> KIT[("output/ — CV + letter")]
    end

    subgraph S4["STAGE 4 · sync — zero-token"]
        KIT --> W1[merge-tracker] --> W2[sync-pdf-flags] --> W3[followup-seed]
        W3 --> R1{{deadline-sweep}} --> R2{{provider-health}}
        R2 --> R3{{verify-pipeline}} --> R4[build-dashboard]
    end

    R4 --> DASH[("career-dashboard")]
```

## The gates, and what each one refuses

| Gate | Stage | Refuses |
|---|---|---|
| `title_filter` / `location_filter` | 1 | Wrong role, wrong place. `always_allow` > `block` > `allow`; outside the home and Munich regions, **remote only** |
| `blacklist` · `_trust-validator` | 1 | Do-not-apply employers; postings whose company and domain disagree |
| **`scan-run-health`** | 1 | Reasoning over a scan that was rate-limited rather than empty |
| **`triage-prefilter`** | 1 | Postings the title and location already settle — 67% of them, at zero token cost |
| `check-liveness` + **`robots-gate`** | 2 | Dead postings; and escalating to a browser UA against a site that declined in robots.txt |
| pre-screen | 2 | Anything below the pursue floor, logged to `discard.log` with its reason |
| `kitCandidates` | 3 | Rows with no report — there is nothing to tailor from, and building anyway is fabrication |
| **language gate** | 3 | A stated German requirement A2 cannot meet (`--allow-language-gap` overrides) |
| `verify-cv-facts` | 3 | Claims not supported by `cv.md` |
| **`verify-pdf-ats`** | 3 | A PDF an ATS parser cannot read, or one that ran to an extra page |

Bold entries were added on 2026-08-31 — each in response to a measured failure,
not a hypothetical one.

## What never happens here

**Nothing is submitted.** No form is filled, no message is sent, no Apply button
is clicked. Every stage produces drafts for review — `AGENTS.md` → Ethical Use.

## Analytics (all zero-token, all read-only)

| Script | Answers |
|---|---|
| `stats.mjs` | Lifetime funnel, scanner totals, portal coverage |
| `analyze-patterns.mjs` | Blockers, archetype conversion, per-vendor advance rate |
| `language-loss.mjs` | How much of the pipeline dies on German — the dominant blocker |
| `funnel-velocity.mjs` | Stage velocity, folded from `data/status-log.tsv` |
| `provider-health.mjs` | Scrapers returning junk without erroring |
| `deadline-sweep.mjs` | Postings past their own stated deadline — no fetch |
| `referral-links.mjs` | Search links for a row with no reachable contact |
