# Mode: pipeline -- URL-indbakke (Second Brain)

Behandler URL'er til opslag, der er samlet i `data/pipeline.md`. Kandidaten tilføjer URL'er, når han vil, og kører derefter `/career-ops pipeline` for at behandle dem alle på én gang.

## Liveness-sweep

**Kør dette, før du behandler nogen URL.** Poster, som scanneren skrev i headless/batch-tilstand, bærer `**Verification:** unconfirmed (batch mode)`, fordi Playwright ikke var tilgængelig på scanningstidspunktet — de er aldrig blevet tjekket for liveness. Uden et sweep når døde opslag frem til evaluering ét ad gangen og brænder tid og tokens af på fantomroller.

1. Kør `node check-liveness.mjs --file data/pipeline.md` (tilføj `--throttle` ved store batches for at holde dig under WAF-rate-limits; det er ren Playwright, nul Claude-tokens). Checkeren læser indbakken direkte — den tager `- [ ]`-rækkerne, ignorerer `- [x]`/`- [!]`-rækker samt `local:`-poster og rapporterer, hvor mange linjer den sprang over. Kopiér **ikke** URLerne manuelt til en midlertidig fil først; det trin koster tokens og er præcis det, der bliver sprunget over.
2. Checkeren udskriver en afgørelse per URL og afslutter med en exit-kode forskellig fra nul, så snart en URL er expired/uncertain.
3. Hver URL, som checkeren melder som **expired/closed**, afklares i stedet for at blive behandlet: flyt den til den behandlede sektion som `- [x] ~~URL | Virksomhed | Rolle~~ — opslag udløbet (liveness sweep)`, og hvis der allerede findes en tracker-række, sæt den til `Discarded`. **Ingen** ekstraktion, evaluering eller report/PDF-generering for den.
4. `uncertain`-resultater bliver stående og bekræftes under den normale ekstraktion (en enkelt forbigående timeout må ikke kassere et muligvis levende opslag).
5. Kun de overlevende, levende URLer går videre til behandlingsløkken nedenfor.

## Workflow

1. **Læs** `data/pipeline.md` -> find `- [ ]`-elementer i sektionen "Afventer" / "Pending" / "Pendientes"
2. **For hver afventende URL**:
   a. Reservér det næste fortløbende `REPORT_NUM` atomisk ved at køre `node reserve-report-num.mjs` (og frigiv sentinel'en ved at køre `node reserve-report-num.mjs --release <num>`, når rapporten er skrevet)
   b. **Udtræk opslaget** med Playwright (`browser_navigate` + `browser_snapshot`) -> WebFetch -> WebSearch
   c. Hvis URL'en ikke er tilgængelig -> markér som `- [!]` med en note og fortsæt
   d. **Kør den fulde auto-pipeline**: Evaluering A-F -> Report .md -> PDF (hvis score >= 3.0) -> Tracker
   e. **Flyt fra "Afventer" til "Behandlede"**: `- [x] #NNN | URL | Virksomhed | Rolle | Score/5 | PDF ja/nej`
3. **Hvis 3+ URL'er afventer**, så start agenter parallelt (Agent-værktøjet med `run_in_background`) for at maksimere hastigheden.
4. **Til sidst** vis en opsummerende tabel:

```
| # | Virksomhed | Rolle | Score | PDF | Anbefalet handling |
```

## Format for pipeline.md

```markdown
## Afventer
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company ApS | Senior PM
- [!] https://private.url/job -- Fejl: login påkrævet

## Behandlede
- [x] #143 | https://jobs.example.com/posting/789 | Acme ApS | AI PM | 4.2/5 | PDF ja
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF nej
```

> Note: Sektionsoverskrifterne kan være på EN ("Pending"/"Processed"), ES ("Pendientes"/"Procesadas"), DE ("Offen"/"Verarbeitet") eller DA ("Afventer"/"Behandlede"). Vær fleksibel ved læsning, tro mod den eksisterende stil ved skrivning.

## Intelligent detektion af opslaget fra URL'en

1. **Playwright (foretrukket):** `browser_navigate` + `browser_snapshot`. Fungerer med alle SPAs.
   - **Tilvalg — CLI-udtrækker (`scan.extractor: cli` i `config/profile.yml`):** kør `node browser-extract.mjs <url>` (`--mode jd`) i stedet — kompakt `{ "url", "title", "text" }`, færre tokens (afhænger af jobportalen). **Fald stille tilbage** til `browser_navigate` + `browser_snapshot` ved fejl eller hvis den mangler.
2. **WebFetch (fallback):** Til statiske sider, eller når Playwright ikke er tilgængelig.
3. **WebSearch (sidste udvej):** Søg på sekundære portaler, der indekserer opslaget.

**Særlige tilfælde:**
- **LinkedIn**: Kan kræve login -> markér `[!]` og bed kandidaten om at indsætte teksten
- **PDF**: Hvis URL'en peger på en PDF, så læs den direkte med Read-værktøjet
- **Præfikset `local:`**: Læs den lokale fil. Eksempel: `local:jds/linkedin-pm-ai.md` -> læs `jds/linkedin-pm-ai.md`
- **Jobindex / The Hub / LinkedIn DK**: Almindelige danske portaler. Playwright håndterer cookie-bannere godt
- **Jobnet (Styrelsen for Arbejdsmarked)**: Strukturerede opslag, godt læsbare af maskine. WebFetch er som regel nok

## Automatisk nummerering

1. Kør `node reserve-report-num.mjs` for at reservere det næste fortløbende nummer atomisk (stdout returnerer `{###}`).
2. Skriv rapporten med dette nummer.
3. Frigiv sentinel'en ved at køre `node reserve-report-num.mjs --release {###}`, når rapporten er skrevet.

## Synkronisering af kilder

Før en URL behandles, tjek synkroniseringen:

```bash
node cv-sync-check.mjs
```

Ved desynkronisering, advar kandidaten, før du fortsætter.
