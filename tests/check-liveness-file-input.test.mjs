// tests/check-liveness-file-input.test.mjs — unit tests for extractPipelineUrls().
//
// The `pipeline` mode Liveness sweep is the cheapest guard in the project: it
// drops dead postings before any of them costs an evaluation. It was also the
// easiest to skip, because it asked the agent to hand-copy every `- [ ]` URL into
// a temp file first. `--file` now reads `data/pipeline.md` directly, so the shapes
// that file can take are pinned here rather than trusted to a live inbox.
//
// This matters twice over: `modes/apply.md` and `docs/APPLY_AUTOFILL.md` have
// printed `--file data/pipeline.md` for a while, and before this parser existed
// that command fed Playwright whole markdown rows as if they were URLs.
//
// The function lives in liveness-core.mjs, not check-liveness.mjs, so this suite
// never pulls Playwright into the in-process test run.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nUtility - check-liveness --file input parsing');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);
  const { extractPipelineUrls } = mod;

  if (typeof extractPipelineUrls !== 'function') {
    fail('liveness-core.mjs does not export extractPipelineUrls');
  } else {
    const cases = [
      {
        name: 'a plain one-URL-per-line list still works unchanged',
        text: 'https://a.example/1\nhttps://b.example/2\n',
        urls: ['https://a.example/1', 'https://b.example/2'],
        skipped: 0,
      },
      {
        name: 'blank lines and # comments are ignored, not counted as skips',
        text: '# my inbox\n\nhttps://a.example/1\n\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'a markdown heading is a comment, so ## Pending never becomes a skip',
        text: '## Pending\n- [ ] https://a.example/1\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'a bare pipeline row (1 column) yields its URL',
        text: '- [ ] https://a.example/1\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'the column separator ends the URL on a 3-column row',
        text: '- [ ] https://a.example/1 | Acme Corp | Senior PM\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'a 5-column row with labeled segments still yields only the URL',
        text: '- [ ] https://a.example/1 | Acme | AI Eng | Remote | 180000 USD | posted: 2026-06-18 | trust: 60 missing_apply_url\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'a row with no space before the pipe does not swallow the separator',
        text: '- [ ] https://a.example/1| Acme\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'processed rows are skipped entirely, not re-checked',
        text: '- [x] #143 | https://a.example/1 | Acme | AI PM | 4.2/5 | PDF ✅\n- [ ] https://b.example/2\n',
        urls: ['https://b.example/2'],
        skipped: 0,
      },
      {
        name: 'an unreachable [!] row is skipped, not re-checked',
        text: '- [!] https://private.example/job — Error: login required\n- [ ] https://b.example/2\n',
        urls: ['https://b.example/2'],
        skipped: 0,
      },
      {
        name: 'a local: entry has no URL and is counted as skipped',
        text: '- [ ] local:jds/linkedin-pm-ai.md\n',
        urls: [],
        skipped: 1,
      },
      {
        name: 'a markdown link yields the bare URL without the trailing paren',
        text: '- [ ] [Acme](https://a.example/1)\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'an angle-bracketed URL drops the closing bracket',
        text: '- [ ] <https://a.example/1>\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'http and https are both accepted',
        text: 'http://a.example/1\nhttps://b.example/2\n',
        urls: ['http://a.example/1', 'https://b.example/2'],
        skipped: 0,
      },
      {
        name: 'a * bullet is treated the same as -',
        text: '* [ ] https://a.example/1\n',
        urls: ['https://a.example/1'],
        skipped: 0,
      },
      {
        name: 'CRLF line endings do not leave a stray \\r on the URL',
        text: '- [ ] https://a.example/1\r\n- [ ] https://b.example/2\r\n',
        urls: ['https://a.example/1', 'https://b.example/2'],
        skipped: 0,
      },
      {
        name: 'prose between sections is counted as skipped, never sent to Playwright',
        text: 'Some notes about the inbox.\n- [ ] https://a.example/1\n',
        urls: ['https://a.example/1'],
        skipped: 1,
      },
      {
        // 0 urls + 0 skips is the "nothing pending" signal the CLI exits 0 on;
        // 0 urls + n skips is the "wrong file" signal it exits 1 on.
        name: 'an all-processed inbox yields no URLs and no skips',
        text: '## Processed\n- [x] #143 | https://a.example/1 | Acme | AI PM | 4.2/5 | PDF ✅\n',
        urls: [],
        skipped: 0,
      },
      {
        name: 'empty input is handled without throwing',
        text: '',
        urls: [],
        skipped: 0,
      },
    ];

    for (const c of cases) {
      const got = extractPipelineUrls(c.text);
      const urlsOk = JSON.stringify(got.urls) === JSON.stringify(c.urls);
      const skipOk = got.skipped === c.skipped;
      if (urlsOk && skipOk) {
        pass(c.name);
      } else {
        fail(
          `${c.name} — expected ${JSON.stringify(c.urls)} (${c.skipped} skipped), ` +
            `got ${JSON.stringify(got.urls)} (${got.skipped} skipped)`
        );
      }
    }

    // A missing/undefined argument must not throw: check-liveness.mjs reads a file
    // the user named, and a bad path should surface as the CLI's own error message.
    try {
      const empty = extractPipelineUrls();
      if (empty.urls.length === 0 && empty.skipped === 0) {
        pass('extractPipelineUrls() with no argument returns an empty result instead of throwing');
      } else {
        fail(`extractPipelineUrls() with no argument returned ${JSON.stringify(empty)}`);
      }
    } catch (e) {
      fail(`extractPipelineUrls() with no argument threw: ${e.message}`);
    }
  }
} catch (e) {
  fail(`check-liveness --file input tests crashed: ${e.message}`);
}
