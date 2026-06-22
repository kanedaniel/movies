#!/usr/bin/env node
// Reads data/needs-review.json and upserts a pinned GitHub issue with its
// contents. Closes the issue when the file has no items.
//
// Expects env: GH_TOKEN, GITHUB_REPOSITORY (owner/repo). Both are provided
// automatically by GitHub Actions. Uses the `gh` CLI for API calls.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REVIEW_PATH = path.join(__dirname, '..', 'data', 'needs-review.json');
const LABEL = 'needs-review';
const TITLE = 'Title resolver: cases needing review';

function gh(args) {
  return execSync(`gh ${args}`, { encoding: 'utf8' });
}

function findExistingIssue() {
  // Returns the issue number or null. Searches both open and recently-closed
  // issues so we can re-open one instead of stacking up duplicates.
  const out = gh(`issue list --label "${LABEL}" --state all --limit 5 --json number,state`);
  const issues = JSON.parse(out);
  if (issues.length === 0) return null;
  // Prefer an open one; otherwise the most recent.
  const open = issues.find(i => i.state === 'OPEN');
  return open ? open.number : issues[0].number;
}

function ensureLabel() {
  try {
    gh(`label list --json name --jq '.[].name' | grep -q '^${LABEL}$'`);
  } catch (e) {
    try {
      gh(`label create ${LABEL} --color FBCA04 --description "Title resolver flagged this for human review"`);
    } catch (e2) { /* already exists; fine */ }
  }
}

function renderBody(review) {
  const { generatedAt, items } = review;
  const lines = [];
  lines.push(`*Last scrape:* ${generatedAt}`);
  lines.push('');
  lines.push(`The title resolver flagged **${items.length}** title(s) for review. Each is one of:`);
  lines.push('- **no-results** — TMDB returned nothing across every query variant');
  lines.push('- **no-match** — top candidate scored below the confidence floor');
  lines.push('- **low-confidence** — top candidate is plausible but uncertain');
  lines.push('- **ambiguous** — top two candidates scored within 0.05 of each other');
  lines.push('- **unknown-prefix** — saw a new ALL-CAPS prefix not in `title-rules.json`');
  lines.push('');
  lines.push('Resolve each by editing `data/tmdb-overrides.json` or `data/title-rules.json`, then commit. Entries you fix disappear on the next scrape.');
  lines.push('');

  const grouped = {};
  for (const item of items) {
    (grouped[item.category] = grouped[item.category] || []).push(item);
  }

  for (const [category, entries] of Object.entries(grouped)) {
    lines.push(`### ${category} (${entries.length})`);
    lines.push('');
    for (const e of entries) {
      lines.push(`- [ ] **${escapeMd(e.scrapedTitle)}** — *${escapeMd(e.cinema || 'unknown cinema')}*`);
      if (e.canonicalTitle && e.canonicalTitle !== e.scrapedTitle) {
        lines.push(`    - Canonical: \`${escapeMd(e.canonicalTitle)}\``);
      }
      if (e.score !== undefined) {
        lines.push(`    - Best score: \`${e.score}\``);
      }
      if (e.prefix) {
        lines.push(`    - Detected prefix: \`${escapeMd(e.prefix)}\``);
      }
      if (e.topCandidates && e.topCandidates.length) {
        lines.push(`    - Candidates:`);
        for (const c of e.topCandidates) {
          lines.push(`      - [${escapeMd(c.title)} (${c.year || '?'})](${c.url}) — score ${c.score}, via \`${c.viaVariant}\``);
        }
      }
      if (e.suggestedFix) {
        lines.push(`    - **Fix:** ${escapeMd(e.suggestedFix)}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_This issue is updated automatically by the scraper. Closing it manually is fine — it\'ll re-open if new items appear._');
  return lines.join('\n');
}

function escapeMd(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\|/g, '\\|');
}

function main() {
  if (!fs.existsSync(REVIEW_PATH)) {
    console.log(`No ${REVIEW_PATH} — nothing to do.`);
    return;
  }
  const review = JSON.parse(fs.readFileSync(REVIEW_PATH, 'utf8'));
  ensureLabel();
  const existingIssue = findExistingIssue();

  if (!review.items || review.items.length === 0) {
    if (existingIssue) {
      gh(`issue close ${existingIssue} --comment "Resolver run is clean — no titles need review. Closing automatically."`);
      console.log(`Closed issue #${existingIssue} (no items to review).`);
    } else {
      console.log('No needs-review items and no existing issue. Done.');
    }
    return;
  }

  const body = renderBody(review);
  // gh CLI takes the body via --body-file
  const tmpBody = path.join(require('os').tmpdir(), `needs-review-body-${process.pid}.md`);
  fs.writeFileSync(tmpBody, body);

  try {
    if (existingIssue) {
      // Re-open if it was closed, then edit the body.
      gh(`issue reopen ${existingIssue}`).toString();
      gh(`issue edit ${existingIssue} --body-file "${tmpBody}" --title "${TITLE}"`);
      console.log(`Updated issue #${existingIssue}: ${review.items.length} item(s).`);
    } else {
      const out = gh(`issue create --title "${TITLE}" --label "${LABEL}" --body-file "${tmpBody}"`);
      const url = out.trim();
      console.log(`Created issue: ${url}`);
    }
  } finally {
    try { fs.unlinkSync(tmpBody); } catch (e) {}
  }
}

try {
  main();
} catch (e) {
  console.error('upsert-review-issue failed:', e.message);
  process.exit(1);
}
