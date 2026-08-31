// tests/stepstone-human-url.test.mjs
//
// StepStone serves a posting at two URLs and neither serves both audiences:
// the canonical `.html` renders for a person but 403s automated clients, while
// `-inline.html` answers a probe with HTTP 200 and carries NO job description.
//
// The tracker stored the probe-friendly one, so eight rows held a link that
// looked broken when opened. The fix is a round trip: store canonical, probe
// inline. These pin both halves — and that each is idempotent, so rows written
// under the old behaviour keep working.
import { pass, fail } from './helpers.mjs';
import { toHumanUrl } from '../loop-core.mjs';
import { fetchableUrl } from '../liveness-browser.mjs';

console.log('\nStepStone URL round trip — store the human link, probe the machine one');

const CANON = 'https://www.stepstone.de/stellenangebote--Werkstudent-Data-Engineer-m-w-d-Muenchen-Sana--14405387.html';
const INLINE = 'https://www.stepstone.de/stellenangebote--Werkstudent-Data-Engineer-m-w-d-Muenchen-Sana--14405387-inline.html';

toHumanUrl(INLINE) === CANON
  ? pass('an inline stub is stored as the canonical, human-openable link')
  : fail(`toHumanUrl(INLINE) = ${toHumanUrl(INLINE)}`);

toHumanUrl(CANON) === CANON
  ? pass('and the canonical link is left alone (idempotent)')
  : fail(`toHumanUrl(CANON) = ${toHumanUrl(CANON)}`);

fetchableUrl(CANON) === INLINE
  ? pass('liveness probes the inline variant, so nothing is lost machine-side')
  : fail(`fetchableUrl(CANON) = ${fetchableUrl(CANON)}`);

fetchableUrl(INLINE) === INLINE
  ? pass('and a row still holding the old inline form probes identically')
  : fail(`fetchableUrl(INLINE) = ${fetchableUrl(INLINE)}`);

toHumanUrl(fetchableUrl(CANON)) === CANON
  ? pass('the round trip returns the canonical link unchanged')
  : fail('round trip did not return the canonical link');

// ── Nothing else may be touched ─────────────────────────────────────────────
for (const [label, url] of [
  ['a StepStone search page (no .html job path)', 'https://www.stepstone.de/jobs/data-science'],
  ['another host that happens to end -inline.html', 'https://example.de/a-inline.html'],
  ['a Siemens requisition', 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/519139'],
]) {
  toHumanUrl(url) === url && fetchableUrl(url) === url
    ? pass(`${label} is untouched by both transforms`)
    : fail(`${label} was rewritten: ${toHumanUrl(url)} / ${fetchableUrl(url)}`);
}

// iCIMS must keep its own iframe rule — the StepStone branch returns early and
// could have shadowed it.
fetchableUrl('https://careers.icims.com/jobs/123/job').includes('in_iframe=1')
  ? pass('the pre-existing iCIMS iframe rule still applies')
  : fail('iCIMS transform was shadowed by the StepStone branch');

for (const junk of ['', 'not a url', null, undefined]) {
  toHumanUrl(junk) === String(junk ?? '')
    ? pass(`unparseable input ${JSON.stringify(junk)} comes back untouched`)
    : fail(`toHumanUrl(${JSON.stringify(junk)}) = ${toHumanUrl(junk)}`);
}
