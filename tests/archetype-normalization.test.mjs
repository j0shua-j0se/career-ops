// tests/archetype-normalization.test.mjs — free-form report archetypes must fold
// onto the canonical list in the user's profile.
//
// Reports write `archetype:` as prose, one ad-hoc slug per evaluation. Across 32
// real reports that produced ~20 buckets — `working-student-ai-ml`, `Working
// Student — AI/ML`, `working-student-ai-ml-primary`, `data-science-working-
// student-weak-partial` and five more all naming ONE archetype. Grouped
// verbatim, almost every bucket had total=1, so the conversion rates this
// analysis exists to produce were computed on samples of one, and the "double
// down on X" recommendation keyed off whichever singleton happened to convert.
//
// The folding must stay conservative: a wrong fold moves a conversion rate on no
// evidence, so ambiguity is reported rather than guessed at.
import { pass, fail } from './helpers.mjs';
import { archetypeTokens, normalizeArchetype, loadCanonicalArchetypes } from '../analyze-patterns.mjs';

console.log('\nArchetype normalization');

const canonical = [
  { name: 'Working Student / Werkstudent — AI, ML, Data Science' },
  { name: 'Internship / Praktikum — AI, ML, Data Science' },
  { name: 'Data Scientist / Data Analyst' },
  { name: 'AI / ML Engineer (LLM, RAG, GenAI)' },
  { name: "Research Assistant / HiWi / Thesis (Master's thesis in industry)" },
  { name: 'MLOps / Data Engineer' },
].map(a => ({ name: a.name, tokens: new Set(archetypeTokens(a.name)) }));

const WS = 'Working Student / Werkstudent — AI, ML, Data Science';
const norm = (raw) => normalizeArchetype(raw, canonical);

// The eight real spellings of one archetype that fragmented the breakdown.
for (const raw of [
  'working-student-ai-ml',
  'Working Student — AI/ML',
  'working-student-ai-ml-primary',
  'working-student-ai-ml-evaluation',
  'data-science-working-student-weak-partial',
  'data-science-working-student-weak-partial-bi-only',
  'ai-ml-working-student-weak-partial-one-bullet',
]) {
  norm(raw) === WS
    ? pass(`"${raw}" -> canonical working-student archetype`)
    : fail(`"${raw}" folded to ${JSON.stringify(norm(raw))}, expected the working-student archetype`);
}

// Separator and case variants must tokenize identically.
norm('AI/ML Engineer') === norm('ai-ml engineer') && norm('AI/ML Engineer') !== null
  ? pass('separator and case variants fold identically')
  : fail('separator/case handling diverges');

// The possessive must fold, or "Master's thesis" never matches "masters-thesis".
norm('masters-thesis-industry') === "Research Assistant / HiWi / Thesis (Master's thesis in industry)"
  ? pass('"masters-thesis-industry" -> the thesis archetype (possessive folded)')
  : fail(`"masters-thesis-industry" folded to ${JSON.stringify(norm('masters-thesis-industry'))}`);

norm('hiwi-research-assistant') === "Research Assistant / HiWi / Thesis (Master's thesis in industry)"
  ? pass('"hiwi-research-assistant" -> the thesis archetype')
  : fail('"hiwi-research-assistant" did not fold');

norm('mlops-data-engineer-adjacent') === 'MLOps / Data Engineer'
  ? pass('"mlops-data-engineer-adjacent" -> MLOps / Data Engineer')
  : fail('"mlops-data-engineer-adjacent" did not fold');

norm('internship-ai-ml') === 'Internship / Praktikum — AI, ML, Data Science'
  ? pass('"internship-ai-ml" -> the internship archetype')
  : fail('"internship-ai-ml" did not fold');

norm('data-analyst-entry') === 'Data Scientist / Data Analyst'
  ? pass('"data-analyst-entry" -> Data Scientist / Data Analyst')
  : fail('"data-analyst-entry" did not fold');

// A lone token that belongs to exactly ONE archetype is discriminating enough.
norm('werkstudent') === WS
  ? pass('a lone unique token ("werkstudent") folds — it names its archetype unambiguously')
  : fail('"werkstudent" did not fold despite being unique to one archetype');

// --- Guards: what must NOT fold.

// "none" means the posting matched no archetype. Folding it would inflate a real
// archetype's total with postings rejected for being off-target.
for (const raw of ['none', 'none-business-process-admin', 'none-off-archetype-commercial-bid-support', 'unknown']) {
  norm(raw) === null
    ? pass(`"${raw}" stays unmapped (explicitly no archetype)`)
    : fail(`"${raw}" folded to ${JSON.stringify(norm(raw))} — off-target postings must not inflate an archetype`);
}

// Genuinely off-archetype values have no canonical home and must not be forced.
norm('senior-frontend-not-applicable') === null
  ? pass('"senior-frontend-not-applicable" stays unmapped')
  : fail('an off-archetype value was forced into a canonical bucket');

norm('out-of-scope-geography') === null
  ? pass('"out-of-scope-geography" stays unmapped')
  : fail('a geography note was read as an archetype');

// A lone token shared by several archetypes is ambiguous — "data" appears in
// four of the six, so it decides nothing.
norm('data') === null
  ? pass('a lone ambiguous token ("data") stays unmapped')
  : fail(`"data" folded to ${JSON.stringify(norm('data'))} despite being ambiguous`);

// Empty and absent inputs must not throw or fold.
norm('') === null && norm(null) === null && norm(undefined) === null
  ? pass('empty/absent archetypes stay unmapped without throwing')
  : fail('empty input mishandled');

// No canonical list (profile missing an archetypes block) disables folding
// rather than crashing the analysis.
normalizeArchetype('working-student-ai-ml', []) === null
  ? pass('an empty canonical list disables folding instead of throwing')
  : fail('empty canonical list mishandled');

// The canonical list is USER-LAYER data and must be read from the profile, never
// derived from reports.
{
  const loaded = loadCanonicalArchetypes();
  Array.isArray(loaded) && loaded.every(a => typeof a.name === 'string' && a.tokens instanceof Set)
    ? pass('loadCanonicalArchetypes reads the profile and returns {name, tokens}')
    : fail('loadCanonicalArchetypes returned an unexpected shape');
}

// A malformed/absent profile must not crash the analysis.
loadCanonicalArchetypes('/nonexistent/profile.yml').length === 0
  ? pass('a missing profile yields no canonical archetypes instead of throwing')
  : fail('missing profile mishandled');
