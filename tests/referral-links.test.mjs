// tests/referral-links.test.mjs
//
// Six overdue follow-ups on 2026-08-31 had no address a human reads. The fix
// is not a people-data broker and not scraping LinkedIn (robots.txt disallows
// /search/, and robots-gate refuses it) — it is handing over search URLs.
//
// The queries have to be usable. A people search matches HEADLINES, so a raw
// posting title or a full legal entity name returns nobody, which reads as
// "no such team" rather than "bad query".
import { pass, fail } from './helpers.mjs';
import { cleanCompany, roleKeywords, buildLinks } from '../referral-links.mjs';

console.log('\nreferral-links — search links a human can actually use');

// ── Company names ───────────────────────────────────────────────────────────
for (const [input, want] of [
  ['Manex AI GmbH', 'Manex AI'],
  ['Primetals Technologies Germany GmbH', 'Primetals Technologies Germany'],
  ['Siemens Energy Global GmbH & Co. KG', 'Siemens Energy Global'],
  // A parenthetical is an expansion, not the name in anyone's headline.
  ['DLR (Deutsches Zentrum fuer Luft- und Raumfahrt e.V.)', 'DLR'],
  // The first entity of a slash-joined pair is the searchable one.
  ['Georg Thieme Verlag KG / Thieme Compliance GmbH', 'Georg Thieme Verlag'],
]) {
  cleanCompany(input) === want
    ? pass(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`)
    : fail(`cleanCompany(${JSON.stringify(input)}) = ${JSON.stringify(cleanCompany(input))}, want ${JSON.stringify(want)}`);
}

// Never strip a name down to nothing: a company literally called "Holding
// GmbH" must still search for something.
cleanCompany('Holding GmbH').length > 0 ? pass('a name made only of suffixes is not emptied') : fail('company emptied');
cleanCompany('') === '' ? pass('an empty company stays empty') : fail('empty company mishandled');

// ── Role keywords ───────────────────────────────────────────────────────────
for (const [role, want] of [
  ['Werkstudent (m/w/d) DevOps/MLOps', 'DevOps MLOps'],
  ['Working Student Data Science (m/f/d)', 'Data Science'],
  ['Studentische Hilfskraft (HiWi) - Physical AI', 'Physical AI'],
  ['Werkstudent KI-Entwicklung fuer Multi-Agenten-Systeme (all genders)', 'KI-Entwicklung Multi-Agenten-Systeme'],
]) {
  roleKeywords(role) === want
    ? pass(`role ${JSON.stringify(role.slice(0, 34))} -> ${JSON.stringify(want)}`)
    : fail(`roleKeywords(${JSON.stringify(role)}) = ${JSON.stringify(roleKeywords(role))}, want ${JSON.stringify(want)}`);
}

// A title that is nothing but boilerplate yields no keyword rather than a
// query for "Werkstudent", which matches every student in the country.
roleKeywords('Werkstudent (m/w/d)') === ''
  ? pass('an all-boilerplate title yields no peer keyword')
  : fail(`boilerplate title produced ${JSON.stringify(roleKeywords('Werkstudent (m/w/d)'))}`);

// ── The links ───────────────────────────────────────────────────────────────
{
  const l = buildLinks('Manex AI GmbH', 'AI Quality Engineer - Working Student (f/m/d)');
  l.recruiter.startsWith('https://www.linkedin.com/search/results/people/?keywords=')
    ? pass('the recruiter link is a people SEARCH url') : fail(`bad recruiter link: ${l.recruiter}`);
  decodeURIComponent(l.recruiter.split('keywords=')[1]) === 'Manex AI recruiter'
    ? pass('the query is properly encoded and reads as a person search')
    : fail(`recruiter query = ${decodeURIComponent(l.recruiter.split('keywords=')[1])}`);
  l.talent.includes('talent%20acquisition')
    ? pass('a talent-acquisition variant is offered alongside "recruiter"') : fail('no talent link');
  l.peers && decodeURIComponent(l.peers.split('keywords=')[1]) === 'Manex AI AI Quality'
    ? pass('the peer link pairs the company with a short role keyword') : fail(`peers = ${l.peers}`);
}
{
  const l = buildLinks('Acme GmbH', 'Werkstudent (m/w/d)');
  l.peers === null
    ? pass('no peer link is produced when the title yields no keyword — better than a useless one')
    : fail(`peer link built from boilerplate: ${l.peers}`);
}

// Every emitted URL is a search page. Nothing here may ever be a fetch target,
// and no field may carry a claimed person.
{
  const l = buildLinks('Zeta AG', 'Data Engineer');
  const urls = [l.recruiter, l.talent, l.peers].filter(Boolean);
  urls.every((u) => u.includes('/search/results/people/'))
    ? pass('every link points at a search page, never a profile')
    : fail('a non-search URL was emitted');
  Object.keys(l).every((k) => !/name|person|contact|email/i.test(k))
    ? pass('the result carries no person, contact or email field — links, not results')
    : fail('a contact-shaped field was returned');
}
