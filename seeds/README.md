# seeds/ — VC Portfolio Seed Fetchers

A complementary discovery path for startup job-seekers: pull a **public VC portfolio company list** and probe each company's ATS for openings, feeding results into the same pipeline as tracked companies in `portals.yml`.

## What this does

`scan-ats-full.mjs` normally discovers companies by walking public ATS directories (Greenhouse, Lever, Ashby, Workday). The `seeds/` layer adds a **high-signal starting point for startup roles**: rather than waiting for companies to appear in ATS directories, we seed the universe from well-known VC portfolios — giving you instant coverage of hundreds of YC/a16z/Index-backed companies.

YC and a16z are both US-weighted; **Index Ventures is the European complement** (Personio, DeepL, Raisin, auxmoney, cargo.one, Pitch, Productboard, Wise, Revolut), which is what a DACH or wider-EU search actually needs.

Flow:
```
VC portfolio API/page
    ↓ seeds/vc-portfolios.mjs
SeedCompany[]
    ↓ toPortalEntry()
PortalEntry (careers_url set to best-guess ATS URL)
    ↓ provider.detect() (same as portals.yml companies)
ATS provider fetches jobs
    ↓ title_filter / location_filter / dedup
data/pipeline.md
```

## Usage

### Via scan-ats-full.mjs (recommended)

```bash
# Seed from Y Combinator portfolio, last 7 days
node scan-ats-full.mjs --seeds yc --since 7

# Seed from all three portfolios, dry-run preview
node scan-ats-full.mjs --seeds yc,a16z,index --dry-run

# Europe-weighted seeding only
node scan-ats-full.mjs --seeds index --since 7

# Combine seeds + regular ATS sources
node scan-ats-full.mjs --seeds yc --ats greenhouse,lever --since 5

# npm shortcuts
npm run scan:seeds   # yc + a16z + index
npm run scan:yc      # YC only
npm run scan:eu      # Index Ventures only
```

### Programmatic

```js
import { fetchYCCompanies, fetchA16zCompanies, fetchIndexCompanies, toPortalEntry, SEED_SOURCES } from './seeds/vc-portfolios.mjs';

// Fetch YC companies
const companies = await fetchYCCompanies();
console.log(companies[0]);
// → { name: 'Stripe', slug: 'stripe', url: 'https://stripe.com', source: 'yc', batch: 'W11' }

// Convert to a PortalEntry for ATS provider.detect()
const entry = toPortalEntry(companies[0]);
// → { name: 'Stripe', careers_url: 'https://job-boards.greenhouse.io/stripe', source: 'yc' }

// Using the registry
for (const [id, source] of Object.entries(SEED_SOURCES)) {
  const companies = await source.fetch();
  console.log(`${source.label}: ${companies.length} companies`);
}
```

## Data sources

| Source | URL | Format | Auth |
|--------|-----|--------|------|
| Y Combinator | `https://api.ycombinator.com/v0.1/companies` | JSON API | None |
| a16z | `https://a16z.com/portfolio/` | Public HTML page | None |
| Index Ventures | `https://www.indexventures.com/companies/` | Public HTML page | None |

- **YC**: Fetches up to 3 pages × 1000 companies. Covers all public YC batches.
- **a16z**: Parses the public portfolio page. Falls back gracefully if the page structure changes.
- **Index Ventures**: One GET, ~300 companies, Europe-weighted. The whole list is server-rendered as plain `<a href="/companies/{slug}/">Name</a>` anchors, so no headless browser and no per-company follow-up requests are needed.
  - The ATS slug is derived from the **company name**, not from Index's own path segment: Index routes Wiz at `/companies/wizio/` and Abacus.ai at `/companies/abacusai/`, which are internal identifiers unrelated to any job board.
  - Names are entity-decoded (`Bloom &amp; Wild`) and stripped of trailing legal suffixes (`CodeSignal, Inc.` → `codesignal`) before the slug is derived.
  - The listing page publishes no company website, so `url` is empty and `toPortalEntry()` resolves through the slug-based ATS guess.

Other European funds were evaluated and rejected for this layer: Point Nine, Northzone, Creandum and Earlybird 404 on their documented portfolio paths, while Speedinvest, Accel, HV Capital and Atomico render their portfolios client-side — nothing for a zero-token, no-browser fetcher to read.

## Security

- All slugs are validated against `SLUG_RE = /^[A-Za-z0-9._-]+$/` before any URL interpolation — consistent with the guard in `scan-ats-full.mjs`.
- Constructed ATS URLs go through the existing `entryOnHost()` SSRF guard before reaching any provider.
- No authentication tokens, no headless browser, no LLM API calls.

## Adding more VC portfolios

1. Add a `parseXyzPayload(payload)` pure function (no network — testable with inline fixtures).
2. Add a `fetchXyzCompanies(opts?)` async function that calls the public endpoint and returns `SeedCompany[]`.
3. If the payload is HTML, add an explicit route in `parseSeedEntries()`. Unknown sources fall through to the YC (JSON) parser, which returns `[]` for HTML — the failure mode is silence, not an error.
4. Register it in `SEED_SOURCES`:

```js
export const SEED_SOURCES = {
  yc: { fetch: fetchYCCompanies, label: 'Y Combinator Portfolio' },
  a16z: { fetch: fetchA16zCompanies, label: 'Andreessen Horowitz (a16z) Portfolio' },
  index: { fetch: fetchIndexCompanies, label: 'Index Ventures Portfolio' },
  // Add yours:
  sequoia: { fetch: fetchSequoiaCompanies, label: 'Sequoia Portfolio' },
};
```

5. Add test cases in `test-all.mjs` (section `9b`) covering your `parseXyzPayload()` function, and add the key to `EXPECTED_SEED_KEYS` there.

**Prerequisite before writing any of it:** confirm the fund actually server-renders its portfolio. Fetch the page and count the anchors — most VC sites render the list client-side, and a source that needs a headless browser or one request per company does not belong in this layer.

## Prior art

The VC-portfolio seeding approach is inspired by [adityachaudhary99/job-hunt](https://github.com/adityachaudhary99/job-hunt) (`02-seeds/fetch_yc.py`, `fetch_a16z.py`), which was the original companion reference cited in issue #1370.
