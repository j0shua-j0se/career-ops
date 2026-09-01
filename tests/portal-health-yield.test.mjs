// tests/portal-health-yield.test.mjs — the health ledger must record how many
// postings a portal actually returned, not just that it answered.
//
// "reachable" is the weakest useful signal a portal scan produces, and this
// session cost two portals to exactly that gap. Deutsche Bahn spent weeks
// pinned to a search id that serves an events board: it answered every probe,
// logged reachable every run, and contributed zero requisitions. FAU returned
// 8 of its 48 postings because the provider fetched one URL per keyword and
// never the listing — also reachable, also green, also wrong. Neither is
// visible in a status column. Both are obvious the moment the count is there
// and it falls.
//
// The column is appended last so historical three-column rows stay readable.
// A row with no count reads back as null — "not measured" — which is a
// different fact from a measured zero and must not be charted as one.
import { pass, fail, ROOT } from './helpers.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

console.log('\nscan.mjs — portal-health.tsv records per-portal yield');

const { appendPortalHealth, loadPortalHealth, PORTAL_HEALTH_HEADER } =
  await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const dir = mkdtempSync(join(tmpdir(), 'portal-health-yield-'));
try {
  // ── A fresh file gets the four-column header and carries the count ──
  const fresh = join(dir, 'fresh.tsv');
  await appendPortalHealth([{ timestamp: '2026-09-01T00:00:00.000Z', company: 'Deutsche Bahn', status: 'reachable', jobs: 467 }], fresh);
  const freshText = readFileSync(fresh, 'utf-8');

  if (freshText.startsWith(PORTAL_HEALTH_HEADER) && PORTAL_HEALTH_HEADER.includes('jobs')) {
    pass('appendPortalHealth() writes a header carrying the jobs column');
  } else {
    fail(`header wrong: ${JSON.stringify(freshText.split('\n')[0])}`);
  }

  const freshRows = loadPortalHealth(fresh);
  if (freshRows.length === 1 && freshRows[0].jobs === 467) {
    pass('loadPortalHealth() reads the recorded yield back as a number');
  } else {
    fail(`yield round-trip wrong: ${JSON.stringify(freshRows)}`);
  }

  // ── A ledger written before the column existed still reads, and its rows
  //    report jobs:null rather than a fabricated zero ──
  const legacy = join(dir, 'legacy.tsv');
  writeFileSync(legacy, 'timestamp\tcompany\tstatus\n2026-08-02T08:13:31.242Z\tSiemens\treachable\n', 'utf-8');
  await appendPortalHealth([{ timestamp: '2026-09-01T00:00:00.000Z', company: 'FAU', status: 'reachable', jobs: 48 }], legacy);
  const rows = loadPortalHealth(legacy);

  const old = rows.find((r) => r.company === 'Siemens');
  const now = rows.find((r) => r.company === 'FAU');
  if (old && old.jobs === null) {
    pass('a pre-column row reads back as jobs:null — unmeasured, not zero');
  } else {
    fail(`legacy row should carry jobs:null, got ${JSON.stringify(old)}`);
  }
  if (now && now.jobs === 48 && rows.length === 2) {
    pass('a new row appends its count alongside the untouched history');
  } else {
    fail(`appended row wrong: ${JSON.stringify(rows)}`);
  }
  if (readFileSync(legacy, 'utf-8').startsWith(PORTAL_HEALTH_HEADER)) {
    pass('the legacy header is widened in place, under the same lock as the append');
  } else {
    fail('legacy header was not migrated');
  }

  // ── A portal that answers but returns nothing is a measured zero, and must
  //    be distinguishable from one that was never measured ──
  const zero = join(dir, 'zero.tsv');
  await appendPortalHealth([{ timestamp: '2026-09-01T00:00:00.000Z', company: 'Zalando', status: 'reachable', jobs: 0 }], zero);
  const zeroRow = loadPortalHealth(zero)[0];
  if (zeroRow && zeroRow.jobs === 0) {
    pass('a measured zero survives the round trip as 0, not null');
  } else {
    fail(`measured zero wrong: ${JSON.stringify(zeroRow)}`);
  }
} catch (e) {
  fail(`portal-health yield tests crashed: ${e.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
