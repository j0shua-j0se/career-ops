// tests/doctor-confirm-fields.test.mjs — unit tests for doctor.mjs findConfirmFields().
//
// `config/profile.yml` ships placeholder values annotated with a `# CONFIRM:`
// comment. Every other doctor check asks "does this file exist"; this one is the
// only thing standing between the user and an application PDF carrying someone
// else's phone number, so its parsing rules are pinned here rather than left to
// a live read of a file whose contents are supposed to change.
//
// Importing doctor.mjs at all is the second thing under test. Until the
// entry-point guard was added, the bottom of that file ran `main()` (or printed
// JSON and called process.exit) on import — so this suite would have taken the
// whole in-process run down with it. See the last assertion.
//
// NOTE: no process.exit() anywhere — test-all.mjs runs discovered suites
// in-process and greps for it.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nUtility - doctor CONFIRM: placeholders');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'doctor.mjs')).href);
  const { findConfirmFields } = mod;

  if (typeof findConfirmFields !== 'function') {
    fail('doctor.mjs does not export findConfirmFields');
  } else {
    const shape = (found) => found.map((f) => `${f.field ?? '(null)'}=${f.note}`).join(' | ');

    const cases = [
      {
        name: 'a comment annotates the key on the following line',
        yaml: 'candidate:\n  # CONFIRM: replace with a German number\n  phone: "7736379437"\n',
        expect: 'phone=replace with a German number',
      },
      {
        name: 'a wrapped comment line continues the note instead of ending it',
        yaml: '  # CONFIRM: LinkedIn lists an Indian mobile\n  #   with no country code\n  phone: "773"\n',
        expect: 'phone=LinkedIn lists an Indian mobile',
      },
      {
        name: 'an inline CONFIRM: value is reported without a preceding comment',
        yaml: 'compensation:\n  target_range: "CONFIRM: what do you actually want"\n',
        expect: 'target_range=what do you actually want',
      },
      {
        name: 'an inline CONFIRM: wins over a stale pending note',
        yaml: '# CONFIRM: outer note\ntarget_range: "CONFIRM: inner note"\n',
        expect: 'target_range=inner note',
      },
      {
        name: 'the header prose about CONFIRM: is not itself a placeholder',
        yaml: '# ⚠️  ITEMS MARKED "CONFIRM:" ARE NOT FROM YOUR LINKEDIN EXPORT\n#     placeholders. Tell the agent the real values.\n\ncandidate:\n  full_name: "Ada Lovelace"\n',
        expect: '',
      },
      {
        name: 'a filled-in file reports nothing',
        yaml: 'candidate:\n  phone: "+49 151 000"\n  email: "a@b.c"\n',
        expect: '',
      },
      {
        name: 'a note orphaned by a blank line is still reported',
        yaml: '# CONFIRM: this lost its key\n\nphone: "+49 151 000"\n',
        expect: '(null)=this lost its key',
      },
      {
        name: 'a note dangling at end of file is still reported',
        yaml: 'phone: "+49 151 000"\n# CONFIRM: nothing follows me\n',
        expect: '(null)=nothing follows me',
      },
      {
        name: 'several placeholders are reported in file order',
        yaml: '# CONFIRM: first\na: 1\n# CONFIRM: second\nb: 2\n',
        expect: 'a=first | b=second',
      },
      {
        name: 'CRLF line endings parse the same as LF',
        yaml: 'candidate:\r\n  # CONFIRM: replace me\r\n  phone: "773"\r\n',
        expect: 'phone=replace me',
      },
      {
        name: 'the marker is matched case-insensitively',
        yaml: '# confirm: lowercase still counts\nphone: "773"\n',
        expect: 'phone=lowercase still counts',
      },
      {
        name: 'an unquoted numeric value is still a key',
        yaml: '# CONFIRM: the target band\ntarget_min: 16\n',
        expect: 'target_min=the target band',
      },
      {
        // The reject/accept lists in profile.yml are sequences, so this is the
        // realistic way a note ends up orphaned: someone puts it above a list.
        name: 'a list item breaks the association and orphans the note',
        yaml: '# CONFIRM: which of these still apply\n- "Betriebswirtschaft"\n- "BWL"\n',
        expect: '(null)=which of these still apply',
      },
    ];

    for (const { name, yaml: text, expect } of cases) {
      let got;
      try {
        got = shape(findConfirmFields(text));
      } catch (e) {
        fail(`findConfirmFields threw on "${name}": ${e.message}`);
        continue;
      }
      if (got === expect) pass(`findConfirmFields: ${name}`);
      else fail(`findConfirmFields: ${name} — got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
    }

    // Non-string input must not throw: confirmFieldsFor() feeds this the result
    // of a file read that can fail, and a doctor that crashes while diagnosing
    // is worse than one that reports nothing.
    for (const [label, input] of [['undefined', undefined], ['null', null], ['a number', 42], ['an empty string', '']]) {
      try {
        const got = findConfirmFields(input);
        if (Array.isArray(got) && got.length === 0) pass(`findConfirmFields(${label}) returns an empty array`);
        else fail(`findConfirmFields(${label}) returned ${JSON.stringify(got)}`);
      } catch (e) {
        fail(`findConfirmFields(${label}) threw: ${e.message}`);
      }
    }

    // Against the real file. Deliberately not asserting WHICH fields are
    // outstanding — the user filling in their phone number must not turn this
    // suite red. What is invariant either way: anything reported has to be a key
    // that actually exists in the file.
    let real = null;
    try {
      real = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
    } catch {
      pass('config/profile.yml not present in this checkout — skipping the live-file check');
    }
    if (real !== null) {
      const found = findConfirmFields(real);
      if (found.length === 0) {
        pass('config/profile.yml has no unfilled CONFIRM: placeholders');
      } else {
        for (const { field, note } of found) {
          if (field === null) {
            fail(`config/profile.yml has a CONFIRM: note with no key attached ("${note}") — the comment is orphaned, move it directly above its key`);
          } else if (new RegExp(`^\\s*${field}\\s*:`, 'm').test(real)) {
            pass(`config/profile.yml CONFIRM: placeholder "${field}" maps to a real key`);
          } else {
            fail(`findConfirmFields reported "${field}", which is not a key in config/profile.yml`);
          }
        }
      }
    }
  }

  // Reaching here proves doctor.mjs's entry-point guard held. Without it the
  // import above would have run the whole doctor and called process.exit(),
  // ending the in-process suite early with a green exit code — a false pass,
  // which is the worst failure a test harness can have.
  pass('importing doctor.mjs does not run the CLI or exit the process');
} catch (e) {
  fail(`doctor CONFIRM: placeholder tests crashed: ${e.message}`);
}
