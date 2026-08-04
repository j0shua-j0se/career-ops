# Modus: pipeline — URL-Inbox (Second Brain)

Verarbeitet URLs von Stellenanzeigen, die in `data/pipeline.md` gesammelt wurden. Der Kandidat wirft URLs ins Inbox, wann immer er eine entdeckt, und führt später `/career-ops pipeline` aus, um sie alle in einem Rutsch zu verarbeiten.

## Gmail-Sweep (zuerst ausführen)

`pipeline` ist der Ort, an dem der Tracker mit der Realität abgeglichen wird. Bewerbungen bewegen sich ohne Zutun: eine Absage trifft ein, ein Recruiter antwortet, ein Interview wird terminiert. Ein Tracker, der nur festhält, was der Kandidat selbst getan hat, ist binnen einer Woche veraltet — und jede nachgelagerte Kennzahl (`stats.mjs`, `analyze-patterns.mjs`, Follow-up-Kadenz) wird daraus berechnet. Deshalb: Postfach sweepen, **bevor** die URL-Inbox angefasst wird.

1. **Suchumfang bestimmen.** `node gmail-sweep.mjs query` gibt eine Gmail-Suche aus, die auf genau die Firmen begrenzt ist, deren Tracker-Zeilen auf `Applied`/`Responded`/`Interview`/`Offer` stehen, innerhalb eines Zeitfensters. Kommt `"query": null` zurück, läuft gerade nichts — direkt zum Liveness-Sweep.
2. **Abrufen.** Diese Suche über den vorhandenen Mail-Zugang ausführen:
   - einen Gmail-Connector/MCP (Threads suchen, dann jede Treffer-Nachricht laden), oder
   - `node plugins.mjs run gmail`, wenn das OAuth-Plugin aktiviert ist (`node plugins.mjs list`).

   **Nur das lesen, was Schritt 1 verlangt.** Nicht im übrigen Postfach stöbern, keine Threads außerhalb der Query öffnen und nichts senden, archivieren, labeln oder löschen. Das ist ein Lesevorgang, und zwar ein eng begrenzter.
3. **Übergeben.** Die abgerufenen Nachrichten als JSON-Array schreiben — `[{"id", "from", "subject", "body", "date"}]` — und `node gmail-sweep.mjs plan --file <messages.json>` ausführen. Das Skript klassifiziert jede Antwort (`reply-matcher.mjs`), ordnet sie einer Tracker-Zeile zu und prüft den resultierenden Statuswechsel.
4. **Den sicheren Teil anwenden.** `node gmail-sweep.mjs apply --file <messages.json>` schreibt die `updates` über `node set-status.mjs --row N` — den kanonischen, gesperrten, validierten und atomaren Schreibpfad. Bewegt werden nur Treffer mit hoher Konfidenz, nur vorwärts (Ausnahme `Rejected`, denn eine Absage kann in jeder Phase eintreffen), und niemals aus einem Endzustand heraus. Alles Übrige landet in `needsReview`.
5. **Berichten, nicht verstecken.** Dem Kandidaten zeigen, was sich bewegt hat (`from` → `to`, pro Firma), und `needsReview` samt `skipReason` auflisten. Nicht angewandte Fälle bleiben in `data/reply-candidates.json` für `node reply-watch.mjs` liegen.

**Warum dieser Schritt schreiben darf.** Ein Statuswechsel ist intern, mit einem einzigen `set-status.mjs`-Aufruf umkehrbar und für niemanden nach außen sichtbar. Er ist keine Bewerbung. `AGENTS.md` → Ethical Use gilt unverändert: hier wird nichts verfasst, gesendet oder eingereicht, und der Sweep antwortet nie auf eine gelesene Nachricht.

Verarbeitete Message-IDs stehen in `data/gmail-sweep-state.json`, damit ein zweiter `pipeline`-Lauf am selben Tag dieselben Wechsel nicht erneut anwendet. `--all` verarbeitet alles neu; `--dry-run` prüft, ohne zu schreiben.

## Liveness-Sweep

**Vor der Verarbeitung jeglicher URLs ausführen.** Einträge, die der Scanner im Headless-/Batch-Modus geschrieben hat, tragen `**Verification:** unconfirmed (batch mode)`, weil Playwright zum Scan-Zeitpunkt nicht verfügbar war — sie wurden nie auf Liveness geprüft. Ohne Sweep erreichen tote Anzeigen die Bewertung einzeln und verbrennen Zeit und Tokens für Phantom-Rollen.

1. `node check-liveness.mjs --file data/pipeline.md` ausführen (bei großen Batches `--throttle` ergänzen, um unter WAF-Rate-Limits zu bleiben; reines Playwright, null Claude-Tokens). Der Checker liest das Inbox direkt — er nimmt die `- [ ]`-Zeilen, ignoriert `- [x]`/`- [!]`-Zeilen sowie `local:`-Einträge und meldet, wie viele Zeilen er übersprungen hat. URLs **nicht** vorher von Hand in eine temporäre Datei kopieren; dieser Schritt kostet Tokens und wird in der Praxis übersprungen.
2. Der Checker gibt pro URL ein Urteil aus und beendet sich mit einem Exit-Code ≠ 0, sobald eine URL expired/uncertain ist.
3. Jede vom Checker als **expired/closed** gemeldete URL wird aufgelöst statt verarbeitet: nach "Verarbeitet" verschieben als `- [x] ~~URL | Firma | Rolle~~ — Anzeige abgelaufen (Liveness-Sweep)` und, falls bereits eine Tracker-Zeile existiert, diese auf `Discarded` setzen. **Keine** Extraktion, Bewertung oder Report-/PDF-Erzeugung dafür.
4. `uncertain`-Ergebnisse bleiben stehen und werden bei der normalen Extraktion bestätigt (ein einzelner Timeout darf keine möglicherweise offene Anzeige verwerfen).
5. Nur die überlebenden, offenen URLs gehen in die Verarbeitungsschleife unten.

## Workflow

0. **Gmail-Sweep** (oben) → Tracker-Status mit dem Postfach abgleichen, vor allem anderen.
1. **Lesen** von `data/pipeline.md` → alle Items mit `- [ ]` im Abschnitt "Pendientes" / "Pending" / "Offen" finden. Zuerst den **Liveness-Sweep** (oben) ausführen und abgelaufene Einträge entfernen.
2. **Für jede offene URL**:
   a. Die nächste fortlaufende `REPORT_NUM` atomar reservieren, indem `node reserve-report-num.mjs` ausgeführt wird (und den Sentinel mit `node reserve-report-num.mjs --release <num>` freigeben, sobald der Report geschrieben ist)
   b. **Stellenanzeige extrahieren** mit Playwright (`browser_navigate` + `browser_snapshot`) → WebFetch → WebSearch
   c. Wenn die URL nicht erreichbar ist → als `- [!]` mit Notiz markieren und weitermachen
   d. **Vollständige Auto-Pipeline ausführen**: A-F-Bewertung → Report .md → PDF (ab der **Bewerbungsmappen-Schwelle**, siehe unten) → Tracker
   e. **Bewerbungsmappe — jede Rolle ab der Schwelle bekommt beide Artefakte.** Liegt der Bewertungsscore auf oder über der Schwelle, entstehen **beide**:
      - der zugeschnittene Lebenslauf als PDF (`modes/pdf.md`), und
      - das Anschreiben (`modes/cover.md`), geschrieben nach `output/{company-slug}-cover-letter.md`.

      Nicht das eine oder das andere. Ein Lebenslauf ohne Anschreiben bedeutet, dass der Kandidat vor dem Absenden doch wieder selbst schreiben muss — genau der Teil, der automatisiert werden sollte. Beides sind Entwürfe zur Durchsicht; `AGENTS.md` → Ethical Use: eingereicht wird nie etwas ohne den Kandidaten.
   f. **Von "Offen" nach "Verarbeitet" verschieben**: `- [x] #NNN | URL | Firma | Rolle | Score/5 | PDF ✅/❌`

   **Die Bewerbungsmappen-Schwelle:** `loop.min_score` aus `config/profile.yml` lesen (Default `3.8`); fehlt der `loop:`-Block, auf `auto_pdf_score_threshold` zurückfallen (Default `3.0`). Innerhalb von `/career-ops pipeline` **schlägt** `loop.min_score` den Wert `auto_pdf_score_threshold` — eine Schwelle entscheidet, was die Scan-Schleife auf die Shortlist setzt *und* wofür die Pipeline eine Mappe erzeugt, damit keine Rolle die Schleife übersteht und danach still übergangen wird, weil sie 0,2 unter einer zweiten, anderen Schwelle liegt. Für `batch/batch-runner.sh` bleibt `auto_pdf_score_threshold` unverändert maßgeblich.

   **Unterhalb der Schwelle:** Report schreiben, beide Artefakte auslassen, im Header `**PDF:** not generated — run /career-ops pdf {company-slug} to create on demand` ausweisen, im Tracker PDF ❌.

   **Zwischen Schwelle und 4.0:** Mappe erzeugen und in der Zusammenfassung klar sagen, dass `AGENTS.md` → Ethical Use von Bewerbungen unter 4.0/5 abrät. Dass die Mappe existiert, ist keine Empfehlung, sie abzuschicken.
3. **Bei 3+ offenen URLs** Agenten parallel starten (Agent-Tool mit `run_in_background`), um Tempo zu machen.
4. **Am Ende** eine Zusammenfassungstabelle ausgeben:

```
| # | Firma | Rolle | Score | PDF | Empfohlene Aktion |
```

## Format von pipeline.md

```markdown
## Offen
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company GmbH | Senior PM
- [!] https://private.url/job — Fehler: Login erforderlich

## Verarbeitet
- [x] #143 | https://jobs.example.com/posting/789 | Acme GmbH | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

> Hinweis: Die Sektion-Überschriften können auf EN ("Pending"/"Processed"), ES ("Pendientes"/"Procesadas") oder DE ("Offen"/"Verarbeitet") sein. Beim Lesen flexibel sein, beim Schreiben dem Stil der bestehenden Datei treu bleiben.

## Intelligente Erkennung der Stellenanzeige aus der URL

1. **Playwright (bevorzugt):** `browser_navigate` + `browser_snapshot`. Funktioniert mit allen SPAs.
   - **Opt-in — CLI-Extraktor (`scan.extractor: cli` in `config/profile.yml`):** stattdessen `node browser-extract.mjs <url>` (`--mode jd`) ausführen — kompaktes `{ "url", "title", "text" }`, weniger Tokens (je nach Jobportal). Bei Fehler oder wenn es fehlt **still** auf `browser_navigate` + `browser_snapshot` zurückfallen.
2. **WebFetch (Fallback):** Für statische Seiten oder wenn Playwright nicht verfügbar ist.
3. **WebSearch (letzter Ausweg):** In sekundären Portalen suchen, die die Stellenanzeige indexieren.

**Sonderfälle:**
- **Cookie-/Consent-Wall (Avature, SAP SuccessFactors und andere White-Label-ATS)**: Ein Consent-Overlay,
  das die Anzeige im Browser verdeckt, ist fast immer reines Client-seitiges JS — der Server hat die
  vollständige Anzeige bereits im initialen HTML geliefert. Zeigt Playwright nur den Consent-Dialog,
  dieselbe URL mit einem **einfachen GET** (`WebFetch`, führt kein JS aus) erneut abrufen, bevor sie als
  `[!]` markiert wird. Bestätigt beim Avature-Tenant von Siemens Healthineers: zwei Anzeigen waren über
  den Browser unlesbar und über einfaches HTTP vollständig. **Ein Consent-Overlay ist kein Beleg dafür,
  dass eine Anzeige geschlossen ist** — den Eintrag deswegen nicht als abgelaufen auflösen. Das ist nur
  ein *Extraktions*-Fallback und lockert die Offer-Verification-Regel aus `AGENTS.md` nicht, die für die
  Liveness-Bestätigung weiterhin Playwright verlangt.
- **LinkedIn**: Kann Login erfordern → mit `[!]` markieren und den Kandidaten bitten, den Text einzufügen
- **PDF**: Wenn die URL auf ein PDF zeigt, direkt mit dem Read-Tool lesen
- **`local:`-Präfix**: Lokale Datei lesen. Beispiel: `local:jds/linkedin-pm-ai.md` → `jds/linkedin-pm-ai.md` lesen
- **StepStone / XING / kununu**: Häufig deutscher Markt, oft Cookie-Banner. Playwright kann in Snapshot scrollen, um den Anzeigentext zu erfassen
- **Bundesagentur für Arbeit (arbeitsagentur.de)**: Strukturierte Stellenanzeigen, gut maschinenlesbar. WebFetch reicht meist

## Automatische Nummerierung

1. Führen Sie `node reserve-report-num.mjs` aus, um die nächste fortlaufende Nummer atomar zu reservieren (die Ausgabe gibt `{###}` zurück).
2. Schreiben Sie den Report mit dieser Nummer.
3. Geben Sie den Sentinel mit `node reserve-report-num.mjs --release {###}` frei, sobald der Report geschrieben ist.

## Synchronisierung der Quellen

Vor dem Verarbeiten irgendeiner URL die Sync prüfen:

```bash
node cv-sync-check.mjs
```

Bei Abweichungen den Kandidaten warnen, bevor weitergearbeitet wird.
