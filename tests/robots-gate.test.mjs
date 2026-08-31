// tests/robots-gate.test.mjs
//
// The gate decides whether escalating to BROWSER_LIKE_USER_AGENT is legitimate.
// It must fail CLOSED: every ambiguous answer means "do not retry". The one
// direction that actually causes harm is granting permission nobody gave.
import { pass, fail } from './helpers.mjs';
import { decide, parseRobots, allowedFor, pathMatches, isRobotsBody } from '../robots-gate.mjs';

console.log('\nrobots-gate — the browser-UA retry needs the site\'s published permission');

const D = (body, path, status = 200) => decide({ status, body, path });

// ── The WAF case: policy allows, firewall does not. Retry is legitimate. ─────
D('User-agent: *\nAllow: /\n', '/en_US/externaljobs/JobDetail/519139').retry
  ? pass('an allow-all policy permits the retry (the WAF-default case)')
  : fail('allow-all policy blocked the retry');

// ── The declined case ───────────────────────────────────────────────────────
{
  const v = D('User-agent: *\nDisallow: /jobs/view/\n', '/jobs/view/123');
  !v.retry && v.code === 'disallowed'
    ? pass('an explicit Disallow refuses the retry')
    : fail(`Disallow classified ${JSON.stringify(v)}`);
}

{
  // Our own token disallowed while * is allowed: still refused.
  const v = D('User-agent: *\nAllow: /\n\nUser-agent: career-ops\nDisallow: /\n', '/anything');
  !v.retry
    ? pass('a Disallow naming our own agent refuses the retry even when * allows')
    : fail('agent-specific Disallow was ignored');
}

// ── Blank lines inside a record must NOT end it ──────────────────────────────
// This is the bug that makes Python's urllib.robotparser fail OPEN on real
// files: it ends the record at the blank line, so the Disallow is dropped.
{
  const body = 'User-agent: *\n\nAllow: /\nDisallow: /cs/\n';
  const v = D(body, '/cs/secret');
  !v.retry
    ? pass('a blank line inside a record does not drop the Disallow that follows')
    : fail('blank line ended the record and lost the Disallow (fails open)');
}

// ── Longest match wins; ties go to Disallow ─────────────────────────────────
D('User-agent: *\nDisallow: /\nAllow: /jobs/\n', '/jobs/123').retry
  ? pass('a longer Allow beats a shorter Disallow')
  : fail('longest-match rule not applied');

{
  const g = parseRobots('User-agent: *\nAllow: /a\nDisallow: /a\n');
  allowedFor(g, '*', '/a') === false
    ? pass('an equal-length Allow/Disallow tie goes to Disallow')
    : fail('tie did not go to Disallow');
}

// ── Failing closed ──────────────────────────────────────────────────────────
{
  const v = D('', '/x', 404);
  v.retry && v.code === 'no_policy'
    ? pass('404 means no published policy, which is permission')
    : fail(`404 classified ${JSON.stringify(v)}`);
}
{
  const v = D('', '/x', 500);
  !v.retry && v.code === 'unreadable'
    ? pass('an unreadable policy (5xx) leaves permission unconfirmed — no retry')
    : fail(`500 classified ${JSON.stringify(v)}`);
}
{
  // A soft-200 HTML error page parses to zero rules, and zero rules would
  // otherwise read as "allowed" — permission that was never granted.
  const v = D('<!doctype html><html><body>Not found</body></html>', '/x', 200);
  !v.retry && v.code === 'not_robots'
    ? pass('a soft-200 HTML page is unreadable, never an empty allow-all')
    : fail(`soft-200 classified ${JSON.stringify(v)}`);
}
{
  // A genuinely empty body IS a valid allow-all under RFC 9309.
  D('', '/x', 200).retry
    ? pass('a genuinely empty policy body is a valid allow-all')
    : fail('empty body was not treated as allow-all');
}

// ── Path matching ───────────────────────────────────────────────────────────
pathMatches('/jobs/*/apply', '/jobs/123/apply') ? pass('wildcards match') : fail('wildcard match failed');
pathMatches('/x$', '/x') && !pathMatches('/x$', '/xy')
  ? pass('a trailing $ anchors the end of the path')
  : fail('end-anchor not honoured');
!pathMatches('', '/anything')
  ? pass('an empty Disallow value matches nothing (it means allow everything)')
  : fail('empty Disallow matched');

isRobotsBody('User-agent: *\nDisallow: /') && !isRobotsBody('<html>nope</html>')
  ? pass('a policy file is told apart from an HTML page')
  : fail('robots body detection wrong');
