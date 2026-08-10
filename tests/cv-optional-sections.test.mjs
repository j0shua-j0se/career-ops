// tests/cv-optional-sections.test.mjs — the optional CV sections (projects,
// education, publications, certifications) must vanish entirely when they have
// no entries, rather than rendering a bare section header with nothing under it.
//
// #1879 fixed this for projects; education is the same bug (not every
// candidate has a degree). Certifications was fixed once directly in
// build-cv-html.mjs, then lost when that logic was generalized into this
// shared module (only projects/education made the cut) — the v1.22.0
// auto-update shipped that regression. All three are delimited by marker
// matching rather than parsed, so the boundary pattern is the whole
// correctness story — see the header comment in cv-sections-core.mjs for the
// failure modes exercised here.
import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { stripEmptySections } from '../cv-sections-core.mjs';

console.log('\ncv-sections-core.mjs — optional sections leave no bare header');

const EMPTY = { projects: [], education: [], publications: [], certifications: [] };
const FULL = {
  projects: [{ name: 'P' }],
  education: [{ degree: 'D' }],
  publications: [{ title: 'Pub' }],
  certifications: [{ title: 'C' }],
};

function check(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Real templates: the sections must actually disappear ------------------
// Assert against the shipped templates so a template edit that renames or
// reorders a marker fails here instead of silently reviving the bare header.
const TEMPLATES = [
  { file: 'templates/cv-template.html', format: 'html', survivor: 'SKILLS', hasCertifications: true, hasPublications: true },
  // zh-minimal is a full-fidelity alternate of cv-template.html, not a reduced
  // one, so it carries the same optional sections and must strip them the same
  // way. It is listed here because it once diverged: it had no publications
  // block at all, which silently dropped them from any payload rendered through
  // it, and its section order differed, which made generate-pdf.mjs demand
  // --allow-reorder for this template alone.
  { file: 'templates/cv-template.zh-minimal.html', format: 'html', survivor: 'SKILLS', hasCertifications: true, hasPublications: true },
  { file: 'templates/resume-template.html', format: 'html', survivor: 'SKILLS', hasCertifications: false, hasPublications: false },
  { file: 'templates/cv-template.tex', format: 'tex', survivor: 'Technical Skills', hasCertifications: false, hasPublications: false },
];

for (const { file, format, survivor, hasCertifications, hasPublications } of TEMPLATES) {
  const template = readFileSync(join(ROOT, file), 'utf-8');
  const name = file.split('/').pop();

  const stripped = stripEmptySections(template, EMPTY, format);
  const projectsMarker = format === 'html' ? '<!-- PROJECTS -->' : 'PROJECTS  %';
  const educationMarker = format === 'html' ? '<!-- EDUCATION -->' : 'Education  %';
  const certificationsMarker = '<!-- CERTIFICATIONS -->'; // html-only; no LaTeX Certifications section exists
  const publicationsMarker = '<!-- PUBLICATIONS -->';     // html-only; no LaTeX Publications section exists

  check(`${name}: empty payload removes the projects block`, stripped.includes(projectsMarker), false);
  check(`${name}: empty payload removes the education block`, stripped.includes(educationMarker), false);
  if (hasCertifications) {
    check(`${name}: empty payload removes the certifications block`, stripped.includes(certificationsMarker), false);
  }
  if (hasPublications) {
    check(`${name}: empty payload removes the publications block`, stripped.includes(publicationsMarker), false);
  }
  check(`${name}: a non-optional neighbouring section survives`, stripped.includes(survivor), true);
  check(`${name}: {{EXPERIENCE}} is untouched`, stripped.includes('{{EXPERIENCE}}'), true);

  // Certifications is the LAST optional section in cv-template.html, so an
  // over-broad end-of-input strip would take the closing tags with it. The
  // template's trailing END marker is what stops that; assert the document
  // still closes rather than trusting the marker to stay put.
  if (format === 'html') {
    check(`${name}: stripping every optional section keeps the document closed`,
      stripped.trimEnd().endsWith('</html>'), true);
  }

  // Populated payload must be a no-op — the strip only ever removes.
  check(`${name}: populated payload leaves the template unchanged`,
    stripEmptySections(template, FULL, format) === template, true);

  // One empty, the rest populated: only the empty one goes.
  const onlyEdu = stripEmptySections(template, { ...FULL, education: [] }, format);
  check(`${name}: empty education alone keeps projects`, onlyEdu.includes(projectsMarker), true);
  check(`${name}: empty education alone drops education`, onlyEdu.includes(educationMarker), false);
  if (hasCertifications) {
    check(`${name}: empty education alone keeps certifications`, onlyEdu.includes(certificationsMarker), true);

    // Certifications empty on its own: every other section survives.
    const onlyCert = stripEmptySections(template, { ...FULL, certifications: [] }, format);
    check(`${name}: empty certifications alone keeps projects`, onlyCert.includes(projectsMarker), true);
    check(`${name}: empty certifications alone keeps education`, onlyCert.includes(educationMarker), true);
    check(`${name}: empty certifications alone drops certifications`, onlyCert.includes(certificationsMarker), false);
    check(`${name}: empty certifications alone keeps the document closed`,
      onlyCert.trimEnd().endsWith('</html>'), true);
  }
  if (hasPublications) {
    // The common case: most candidates have published nothing, so the
    // publications strip runs on nearly every build.
    const onlyPub = stripEmptySections(template, { ...FULL, publications: [] }, format);
    check(`${name}: empty publications alone keeps education`, onlyPub.includes(educationMarker), true);
    check(`${name}: empty publications alone keeps certifications`, onlyPub.includes(certificationsMarker), true);
    check(`${name}: empty publications alone drops publications`, onlyPub.includes(publicationsMarker), false);
    check(`${name}: empty publications alone keeps skills`, onlyPub.includes(survivor), true);
  }
}

// --- Boundary edge cases ---------------------------------------------------
// Each of these silently reintroduces the bare header if the boundary pattern
// is written loosely.

// A non-marker comment inside a section body is not a boundary. A lookahead of
// `(?=<!-- [A-Z])` stops here and strands the rest of the block.
const internalComment = [
  '<!-- PROJECTS -->',
  '<div class="section">',
  '  <!-- Main block -->',
  '  <div class="section-title">Projects</div>',
  '</div>',
  '<!-- EDUCATION -->',
  'keep me',
].join('\n');
// Only projects is empty here: with EMPTY, education would also be stripped to
// end of input and the fixture could not distinguish a correct strip from an
// over-broad one.
check('an ordinary comment inside the body is not treated as a boundary',
  stripEmptySections(internalComment, { projects: [], education: [{ degree: 'D' }] }, 'html'),
  '<!-- EDUCATION -->\nkeep me');

// A section that is last in the template still gets removed. Without an
// end-of-input branch there is no boundary to stop at and the strip no-ops.
check('html: a trailing optional section is removed at end of template',
  stripEmptySections('<!-- HEADER -->\nkeep\n<!-- PROJECTS -->\n<div>drop</div>\n', EMPTY, 'html').trim(),
  '<!-- HEADER -->\nkeep');

check('tex: a trailing optional section is removed at end of document',
  stripEmptySections('%%%%  Heading  %%%%\nkeep\n%%%%  PROJECTS  %%%%\ndrop\n', EMPTY, 'tex').trim(),
  '%%%%  Heading  %%%%\nkeep');

// Stripping one section must not depend on the other still being present: a
// lookahead naming `<!-- EDUCATION -->` breaks once education is removed.
const bothEmpty = [
  '<!-- PROJECTS -->',
  '<div>projects body</div>',
  '<!-- EDUCATION -->',
  '<div>education body</div>',
  '<!-- SKILLS -->',
  'skills',
].join('\n');
check('both sections empty: neither body survives',
  stripEmptySections(bothEmpty, EMPTY, 'html'),
  '<!-- SKILLS -->\nskills');

// A missing key is as empty as an empty array — payloads routinely omit these.
check('an absent projects key is treated as empty',
  stripEmptySections(bothEmpty, {}, 'html'),
  '<!-- SKILLS -->\nskills');

// An unknown format is a programming error, not a silent pass-through.
let threw = false;
try { stripEmptySections('x', EMPTY, 'pdf'); } catch { threw = true; }
check('an unknown template format throws', threw, true);
