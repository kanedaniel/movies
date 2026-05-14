// Smoke tests for the title pipeline. Pure functions only — no TMDB API
// calls, no Puppeteer. Run with: npm run test:title-pipeline
//
// Exit 0 on success, non-zero on first failure.

const path = require('path');
const {
  canonicalizeTitle,
  generateQueryVariants,
  scoreCandidate,
  detectUnknownPrefix,
  loadTitleRules
} = require('../src/title-pipeline');

const rules = loadTitleRules(path.join(__dirname, '..', 'data', 'title-rules.json'));

let passed = 0;
let failed = 0;
const fails = [];

function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    fails.push(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

function approxEq(actual, expected, tolerance, name) {
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
  } else {
    failed++;
    fails.push(`  ✗ ${name}\n      expected: ~${expected} (±${tolerance})\n      actual:   ${actual}`);
  }
}

function includes(arr, predicate, name) {
  if (arr.some(predicate)) {
    passed++;
  } else {
    failed++;
    fails.push(`  ✗ ${name}\n      no element matched the predicate in: ${JSON.stringify(arr)}`);
  }
}

// ----------------------------------------------------------------------------
// canonicalizeTitle
// ----------------------------------------------------------------------------

eq(
  canonicalizeTitle('THE DRAMA', 'Sun Theatre', rules),
  'The Drama',
  'Sun Theatre: ALL CAPS → Title Case'
);

eq(
  canonicalizeTitle('ANATOMY OF A FALL', 'Sun Theatre', rules),
  'Anatomy of a Fall',
  'Sun Theatre: minor words stay lowercase'
);

eq(
  canonicalizeTitle('IMAX TENET', 'Sun Theatre', rules),
  'IMAX Tenet',
  'Sun Theatre: acronyms preserved'
);

eq(
  canonicalizeTitle('THE DRAMA', 'Cinema Nova', rules),
  'THE DRAMA',
  'Non-whitelisted cinema: ALL CAPS left alone'
);

eq(
  canonicalizeTitle('Anatomy of a Fall', 'Cinema Nova', rules),
  'Anatomy of a Fall',
  'Mixed case from other cinemas passes through'
);

eq(
  canonicalizeTitle('Drama, The', 'Cinema Nova', rules),
  'The Drama',
  'Article move: "Drama, The" → "The Drama"'
);

eq(
  canonicalizeTitle('Big Heat, the', 'Cinema Nova', rules),
  'The Big Heat',
  'Article move: lowercase the gets capitalized'
);

eq(
  canonicalizeTitle('Story, An', 'Cinema Nova', rules),
  'An Story',
  'Article move: "An" suffix'
);

eq(
  canonicalizeTitle('DRAMA, THE', 'Sun Theatre', rules),
  'The Drama',
  'Combined: Sun Theatre case-fix + article move'
);

// ----------------------------------------------------------------------------
// generateQueryVariants
// ----------------------------------------------------------------------------

const v1 = generateQueryVariants('Top Gun: Maverick (Top Gun Day Re-release)', rules);
includes(v1, x => x.q === 'Top Gun: Maverick' && x.why === 'stripped-trailing-paren',
  'Variants: strip trailing paren from Top Gun re-release');
includes(v1, x => x.q === 'Top Gun: Maverick (Top Gun Day Re-release)' && x.why === 'as-is',
  'Variants: as-is always included');

const v2 = generateQueryVariants('GER26 Berlin Hero', rules);
includes(v2, x => x.q === 'Berlin Hero' && x.why === 'stripped-festival-prefix',
  'Variants: strip GER26 prefix');

const v3 = generateQueryVariants('The Devil Wears Prada 2 - Cry Baby', rules);
includes(v3, x => x.q === 'Cry Baby' && x.why === 'dash-split',
  'Variants: dash-split right half');
includes(v3, x => x.q === 'The Devil Wears Prada 2' && x.why === 'dash-split',
  'Variants: dash-split left half');

const v4 = generateQueryVariants('Calle Málaga (Malaga Street)', rules);
includes(v4, x => x.q === 'Calle Málaga' && x.why === 'stripped-trailing-paren',
  'Variants: strip parenthetical translation');
includes(v4, x => x.q === 'Calle Malaga' && x.why === 'unaccented',
  'Variants: unaccented form');

const v5 = generateQueryVariants('Spider-Man: Into the Spider-Verse', rules);
eq(v5.filter(x => x.why === 'dash-split').length, 0,
  'Variants: plain hyphen (no spaces) does NOT trigger dash-split');

// ----------------------------------------------------------------------------
// scoreCandidate
// ----------------------------------------------------------------------------

const perfectMatch = scoreCandidate(
  { title: 'Top Gun: Maverick', popularity: 50, release_date: '2022-05-24' },
  'Top Gun: Maverick'
);
approxEq(perfectMatch.score, 1.0, 0.1, 'Score: exact title match scores high');

const closeMatch = scoreCandidate(
  { title: 'Top Gun', popularity: 30, release_date: '1986-05-16' },
  'Top Gun: Maverick'
);
approxEq(closeMatch.score, 0.55, 0.2, 'Score: close but not exact');

const badMatch = scoreCandidate(
  { title: 'Drive', popularity: 20 },
  'Top Gun: Maverick'
);
if (badMatch.score < 0.5) passed++;
else { failed++; fails.push(`  ✗ Score: unrelated title should score low (got ${badMatch.score})`); }

const yearMatch = scoreCandidate(
  { title: 'Heat', popularity: 30, release_date: '1995-12-15' },
  'Heat',
  '1995'
);
const wrongYear = scoreCandidate(
  { title: 'Heat', popularity: 30, release_date: '2024-04-04' },
  'Heat',
  '1995'
);
if (yearMatch.score > wrongYear.score) passed++;
else { failed++; fails.push(`  ✗ Score: matching year should beat wrong year`); }

// TV show field handling
const tvMatch = scoreCandidate(
  { name: 'Twin Peaks', popularity: 40, first_air_date: '1990-04-08' },
  'Twin Peaks'
);
approxEq(tvMatch.score, 1.0, 0.1, 'Score: TV show uses .name and .first_air_date');

// ----------------------------------------------------------------------------
// detectUnknownPrefix
// ----------------------------------------------------------------------------

eq(detectUnknownPrefix('BIFF26 A Fading Man', rules), null,
  'Unknown prefix: known prefix returns null');

eq(detectUnknownPrefix('XYZ24 Some Film', rules), 'XYZ24',
  'Unknown prefix: unknown ALL-CAPS+digits prefix is detected');

eq(detectUnknownPrefix('TENET', rules), null,
  'Unknown prefix: single all-caps word (no trailing word) is not flagged');

eq(detectUnknownPrefix('Top Gun: Maverick', rules), null,
  'Unknown prefix: normal title not flagged');

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  fails.forEach(f => console.log(f));
  process.exit(1);
}
console.log('All title-pipeline tests passed.');
