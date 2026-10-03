// tests/scan-filter-fingerprint.test.mjs — title/location skips dedup only
// while the filters that produced them are unchanged.
//
// Observed 2026-10-03: the location policy changed to "anywhere in Germany",
// but 109 Interamt postings already recorded as `skipped_location` stayed in
// the seen set forever, so a rescan counted them as duplicates instead of
// re-applying the new filter. The same rows were also re-appended on every
// run (14,333 skipped_title rows for 3,709 distinct URLs).
import { pass, fail } from './helpers.mjs';
import {
  shouldDedupScanHistoryRow, collectSeenUrls, scanFilterFingerprint, filterSkipStatus,
} from '../scan.mjs';

console.log('\nscan.mjs — filter-fingerprinted scan-history skips');

const cfgA = { title_filter: { positive: ['data'], negative: ['senior'] }, location_filter: { always_allow: ['Erlangen'] } };
const cfgB = { title_filter: { positive: ['data'], negative: ['senior'] }, location_filter: { always_allow: ['Erlangen', 'Berlin'] } };
const fpA = scanFilterFingerprint(cfgA);
const fpB = scanFilterFingerprint(cfgB);

{
  const reordered = { location_filter: { always_allow: ['Erlangen'] }, title_filter: { negative: ['senior'], positive: ['data'] } };
  if (/^[0-9a-f]{8}$/.test(fpA) && fpA !== fpB && scanFilterFingerprint(reordered) === fpA) {
    pass('scanFilterFingerprint changes with the filters and ignores key order');
  } else {
    fail(`fingerprint unstable or insensitive: A=${fpA} B=${fpB} reordered=${scanFilterFingerprint(reordered)}`);
  }
}

{
  const stamped = filterSkipStatus('skipped_location', fpA);
  const same = shouldDedupScanHistoryRow({ firstSeen: '2026-09-01', status: stamped }, { filterFingerprint: fpA });
  const changed = shouldDedupScanHistoryRow({ firstSeen: '2026-09-01', status: stamped }, { filterFingerprint: fpB });
  const legacy = shouldDedupScanHistoryRow({ firstSeen: '2026-09-01', status: 'skipped_location' }, { filterFingerprint: fpB });
  const noPolicy = shouldDedupScanHistoryRow({ firstSeen: '2026-09-01', status: stamped }, {});
  const dateSkip = shouldDedupScanHistoryRow({ firstSeen: '2026-09-01', status: 'skipped_date' }, { filterFingerprint: fpB });
  if (stamped === `skipped_location@${fpA}` && same && !changed && !legacy && noPolicy && dateSkip) {
    pass('a filter skip dedups under the same filters and is rechecked after they change (legacy rows once)');
  } else {
    fail(`dedup decisions wrong: same=${same} changed=${changed} legacy=${legacy} noPolicy=${noPolicy} dateSkip=${dateSkip}`);
  }
}

{
  const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n';
  const history = header + [
    `https://x.test/1\t2026-09-01\tinteramt\tData\tA\tskipped_location@${fpA}`,
    'https://x.test/2\t2026-09-01\tinteramt\tData\tA\tskipped_location',
    `https://x.test/3\t2026-09-01\tinteramt\tData\tA\tskipped_title@${fpB}`,
    'https://x.test/4\t2026-09-01\tinteramt\tData\tA\tskipped_title',
    'https://x.test/4\t2026-09-05\tinteramt\tData\tA\tadded',
  ].join('\n');
  const { seen, filterRecheck } = collectSeenUrls({ scanHistoryText: history }, { filterFingerprint: fpB });
  const ok = seen.has('https://x.test/1') === false && filterRecheck.has('https://x.test/1')
    && filterRecheck.has('https://x.test/2')
    && seen.has('https://x.test/3') && !filterRecheck.has('https://x.test/3')
    && seen.has('https://x.test/4') && !filterRecheck.has('https://x.test/4');
  if (ok) {
    pass('collectSeenUrls returns stale filter skips as filterRecheck, never a URL that was also added');
  } else {
    fail(`seen=${[...seen].join(',')} recheck=${[...filterRecheck].join(',')}`);
  }
}
