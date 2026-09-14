import { pass, fail } from './helpers.mjs';
import { delegatedAuthorshipClaims, factClaims, verifyFacts } from '../verify-cv-facts.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

console.log('\nNon-metric fact gate');

const tmp = mkdtempSync(join(tmpdir(), 'career-ops-nonmetric-facts-'));
try {
  const source = join(tmp, 'cv.md');
  const config = join(tmp, 'cv-facts.json');
  writeFileSync(source, 'Senior Platform Engineer at Acme Labs. Built using React and Docker. Cut spend to $120k and closed a €90,000 deal.');
  writeFileSync(config, JSON.stringify({ allow_metrics: [], allow_facts: [], forbidden_phrases: [] }));

  const claims = factClaims('I worked at Acme Labs as a Senior Platform Engineer, using React and Docker.');
  if (claims.some(claim => claim.kind === 'employer' && claim.value === 'acme labs')
      && claims.some(claim => claim.kind === 'title' && claim.value === 'senior platform engineer')
      && claims.some(claim => claim.kind === 'tool' && claim.value === 'react')) {
    pass('extracts employer, title, and tool claims');
  } else {
    fail(`claim extraction incomplete: ${JSON.stringify(claims)}`);
  }

  const supported = verifyFacts('I worked at Acme Labs as a Senior Platform Engineer, using React and Docker.', {
    sourcePaths: [source], configPath: config,
  });
  if (supported.verdict === 'pass' && supported.unsupportedFacts.length === 0) {
    pass('source-backed non-metric facts pass');
  } else {
    fail(`source-backed non-metric facts blocked: ${JSON.stringify(supported)}`);
  }

  const supportedCurrency = verifyFacts('Cut spend to $120k and closed a €90,000 deal.', {
    sourcePaths: [source], configPath: config,
  });
  if (supportedCurrency.verdict === 'pass' && supportedCurrency.invented.length === 0) {
    pass('source-backed currency metrics pass');
  } else {
    fail(`source-backed currency metrics were blocked: ${JSON.stringify(supportedCurrency)}`);
  }

  const unsupportedCurrency = verifyFacts('Generated $5M and saved £2.5M.', {
    sourcePaths: [source], configPath: config,
  });
  if (unsupportedCurrency.verdict === 'block'
      && unsupportedCurrency.invented.includes('$5m')
      && unsupportedCurrency.invented.includes('£2.5m')) {
    pass('unsupported currency metrics block');
  } else {
    fail(`unsupported currency metrics bypassed the fact gate: ${JSON.stringify(unsupportedCurrency)}`);
  }

  const unsupported = verifyFacts('I worked at Invented Labs as a Principal Platform Engineer, using React and Terraform.', {
    sourcePaths: [source], configPath: config,
  });
  if (unsupported.verdict === 'block'
      && unsupported.unsupportedFacts.some(claim => claim.value === 'invented labs')
      && unsupported.unsupportedFacts.some(claim => claim.value === 'principal platform engineer')
      && unsupported.unsupportedFacts.some(claim => claim.value === 'terraform')) {
    pass('unsupported employer, title, and tool claims block');
  } else {
    fail(`unsupported non-metric facts were not blocked: ${JSON.stringify(unsupported)}`);
  }

  const lowercaseUnknownTool = verifyFacts('built using react with kubernetes and google cloud.', {
    sourcePaths: [source], configPath: config,
  });
  if (lowercaseUnknownTool.verdict === 'block'
      && lowercaseUnknownTool.unsupportedFacts.some(claim => claim.value === 'kubernetes')
      && lowercaseUnknownTool.unsupportedFacts.some(claim => claim.value === 'google cloud')) {
    pass('explicit lowercase tool claims fail closed without a whitelist entry');
  } else {
    fail(`lowercase tool claims bypassed the fact gate: ${JSON.stringify(lowercaseUnknownTool)}`);
  }

  const trailingProse = factClaims('I built this using React and Docker for containerized deployments.');
  if (trailingProse.some(claim => claim.kind === 'tool' && claim.value === 'react')
      && trailingProse.some(claim => claim.kind === 'tool' && claim.value === 'docker')
      && !trailingProse.some(claim => claim.value.includes('containerized deployments'))) {
    pass('tool claims stop before trailing prepositional prose');
  } else {
    fail(`tool claim over-captured trailing prose: ${JSON.stringify(trailingProse)}`);
  }

  const connectorTools = factClaims('I built this using React with Redux in Dify.');
  if (connectorTools.some(claim => claim.kind === 'tool' && claim.value === 'react')
      && connectorTools.some(claim => claim.kind === 'tool' && claim.value === 'redux')
      && connectorTools.some(claim => claim.kind === 'tool' && claim.value === 'dify')) {
    pass('tool claims split across with/in connectors');
  } else {
    fail(`connector-separated tool claims were not extracted: ${JSON.stringify(connectorTools)}`);
  }

  const proseTools = factClaims('I worked with the team in London.');
  const contextualTool = factClaims('I built using React in production.');
  if (contextualTool.some(claim => claim.value === 'react')
      && proseTools.length === 0) {
    pass('tool extraction filters ordinary prose around technology names');
  } else {
    fail(`ordinary prose was extracted as a tool: ${JSON.stringify({ proseTools, contextualTool })}`);
  }

  const proseTitle = factClaims('The company was recognized as a Top Employer.');
  if (!proseTitle.some(claim => claim.kind === 'title')) {
    pass('ordinary as prose is not treated as a title claim');
  } else {
    fail(`ordinary prose produced a false title claim: ${JSON.stringify(proseTitle)}`);
  }

  const boundary = verifyFacts('I am using Go and Google Cloud.', {
    sourcePaths: [source], configPath: config,
  });
  if (boundary.unsupportedFacts.some(claim => claim.kind === 'tool' && claim.value === 'go')) {
    pass('fact matching does not accept embedded substrings');
  } else {
    fail(`fact matching accepted an embedded substring: ${JSON.stringify(boundary)}`);
  }

  const delegatedSource = [
    'Sourced and directed vendor Acme Interactive through the WebGL build of an in-store kiosk.',
    'Built the internal deployment pipeline using Node.js.',
  ].join('\n');
  writeFileSync(source, delegatedSource);

  const escalatedText = 'Designed the interaction model and wrote the WebGL implementation for an in-store kiosk.';
  const escalatedClaims = delegatedAuthorshipClaims(escalatedText, delegatedSource);
  const escalated = verifyFacts(escalatedText, {
    sourcePaths: [source], configPath: config,
  });
  if (escalated.verdict === 'block'
      && escalatedClaims.some(claim => claim.kind === 'authorship' && claim.value.includes('wrote webgl implementation'))
      && escalated.unsupportedFacts.some(claim => claim.kind === 'authorship')) {
    pass('third-party implementation rewritten as direct authorship blocks');
  } else {
    fail(`delegated implementation was promoted to direct authorship: ${JSON.stringify({ escalatedClaims, escalated })}`);
  }

  const relativeClauseSource = [
    'Managed vendor Acme Interactive, which built the WebGL implementation for an in-store kiosk.',
    'Oversaw contractors who developed the onboarding automation in Node.js.',
  ].join('\n');
  const relativeClauseCases = [
    ['Wrote the WebGL implementation for an in-store kiosk.', 'vendor relative clause is treated as delegated execution'],
    ['Developed the onboarding automation in Node.js.', 'contractor relative clause is treated as delegated execution'],
  ];
  writeFileSync(source, relativeClauseSource);
  for (const [target, label] of relativeClauseCases) {
    const claims = delegatedAuthorshipClaims(target, relativeClauseSource);
    const result = verifyFacts(target, { sourcePaths: [source], configPath: config });
    if (claims.some(claim => claim.kind === 'authorship') && result.verdict === 'block') {
      pass(label);
    } else {
      fail(`${label} was accepted: ${JSON.stringify({ claims, result })}`);
    }
  }

  const attributionKept = verifyFacts('Directed vendor Acme Interactive through the WebGL build of an in-store kiosk.', {
    sourcePaths: [source], configPath: config,
  });
  if (attributionKept.verdict === 'pass'
      && !attributionKept.unsupportedFacts.some(claim => claim.kind === 'authorship')) {
    pass('a rewrite that keeps third-party attribution passes');
  } else {
    fail(`preserved vendor attribution was blocked: ${JSON.stringify(attributionKept)}`);
  }

  const unrelatedDirectWork = verifyFacts('Built the internal deployment pipeline using Node.js.', {
    sourcePaths: [source], configPath: config,
  });
  if (unrelatedDirectWork.verdict === 'pass'
      && !unrelatedDirectWork.unsupportedFacts.some(claim => claim.kind === 'authorship')) {
    pass('unrelated source-backed direct work is not matched to delegated work');
  } else {
    fail(`source-backed direct work was blocked: ${JSON.stringify(unrelatedDirectWork)}`);
  }

  const ambiguousSource = 'Directed vendor Acme Interactive through the WebGL build and wrote the kiosk integration layer.';
  const ambiguous = delegatedAuthorshipClaims('Wrote the kiosk integration layer.', ambiguousSource);
  if (ambiguous.length === 0) {
    pass('mixed direct and delegated source statements fail open');
  } else {
    fail(`ambiguous mixed-authorship source was blocked: ${JSON.stringify(ambiguous)}`);
  }

  const separateDirectEvidence = [
    'Directed vendor Acme Interactive through the WebGL build of an in-store kiosk.',
    'Wrote the WebGL implementation for an in-store kiosk prototype.',
  ].join('\n');
  const directlySupported = delegatedAuthorshipClaims(
    'Wrote the WebGL implementation for an in-store kiosk prototype.',
    separateDirectEvidence,
  );
  if (directlySupported.length === 0) {
    pass('separate direct-work evidence wins over overlapping delegated work');
  } else {
    fail(`explicit direct-work evidence was ignored: ${JSON.stringify(directlySupported)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A trigger inside a NEGATED clause is not a claim.
//
// "I have not worked with FastAPI" registered a FastAPI *tool claim*, so the
// gate demanded source evidence for a technology the sentence explicitly
// disclaims — a cover letter could not name a technology in order to say it is
// absent. The fix is deliberately tight: the negator must sit in the same
// clause, within two words of the trigger. Dropping a real claim is the unsafe
// direction (an unflagged fabrication), so every guard below matters as much as
// the fix itself.
console.log('\nNon-metric fact gate — negated clauses are not claims');

const toolValues = (text) => factClaims(text).filter(c => c.kind === 'tool').map(c => c.value);
const allValues = (text) => factClaims(text).map(c => c.value);

// The reported bug.
!toolValues('I have not worked with FastAPI.').includes('fastapi')
  ? pass('"have not worked with FastAPI" is not a tool claim')
  : fail('negated tool claim still extracted — a technology cannot be disclaimed by name');

!toolValues('I have never worked with Kubernetes.').includes('kubernetes')
  ? pass('"never worked with Kubernetes" is not a tool claim')
  : fail('"never" did not suppress the tool claim');

!toolValues('Delivered the migration without using Terraform.').includes('terraform')
  ? pass('"without using Terraform" is not a tool claim')
  : fail('"without" did not suppress the tool claim');

!toolValues('I have no commercial experience using Scala.').includes('scala')
  ? pass('"no commercial experience using Scala" is not a tool claim')
  : fail('"no ... experience using" did not suppress the tool claim');

// Negation suppresses employer and title triggers on the same terms.
!allValues('I have not worked at Initech as a Principal Engineer.').includes('initech')
  ? pass('"have not worked at Initech" is not an employer claim')
  : fail('negated employer claim still extracted');

// --- Guards: the gate must keep flagging everything it flagged before.

toolValues('Built the service using FastAPI and Postgres.').includes('fastapi')
  ? pass('an ordinary affirmative tool claim is still extracted')
  : fail('REGRESSION: affirmative tool claim lost — fabrications would ship unflagged');

allValues('I worked at Acme Labs as a Senior Platform Engineer.').includes('acme labs')
  ? pass('an ordinary affirmative employer claim is still extracted')
  : fail('REGRESSION: affirmative employer claim lost');

// A negation in a PREVIOUS sentence must not suppress the next one's claim.
toolValues('That project did not ship. Built the API using FastAPI.').includes('fastapi')
  ? pass('a negation in a previous sentence does not suppress the next claim')
  : fail('REGRESSION: negation leaked across a sentence boundary');

// Nor across a clause boundary inside one sentence.
toolValues('Testing was not automated; the service was built using FastAPI.').includes('fastapi')
  ? pass('a negation in a previous clause does not suppress the claim')
  : fail('REGRESSION: negation leaked across a clause boundary');

// Distance guard: a negator far from the trigger is not treated as negating it.
toolValues('We did not have a platform team, a data team or any SRE cover, so I built it using FastAPI.').includes('fastapi')
  ? pass('a distant negator does not suppress the claim')
  : fail('REGRESSION: distant negation suppressed a real claim');
