// Title normalization pipeline for the cinema scraper.
//
// Two phases:
//   1. canonicalizeTitle  → mutates the title we store + display + query
//                           (source-specific Title Case, article move).
//   2. generateQueryVariants → produces multiple TMDB query strings from the
//                              canonical title (for the resolver fallback
//                              cascade — display title stays canonical).

const fs = require('fs');
const path = require('path');
const { distance } = require('fastest-levenshtein');

const DEFAULT_RULES_PATH = path.join(__dirname, '..', 'data', 'title-rules.json');

function loadTitleRules(rulesPath = DEFAULT_RULES_PATH) {
  const defaults = {
    festivalPrefixes: [],
    titleCaseAcronyms: [],
    titleCaseSourceWhitelist: []
  };
  try {
    if (!fs.existsSync(rulesPath)) return defaults;
    const raw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    return {
      festivalPrefixes: raw.festivalPrefixes || [],
      titleCaseAcronyms: raw.titleCaseAcronyms || [],
      titleCaseSourceWhitelist: raw.titleCaseSourceWhitelist || []
    };
  } catch (e) {
    console.warn(`Could not load title rules from ${rulesPath}: ${e.message}`);
    return defaults;
  }
}

// ============================================================================
// CANONICAL PHASE — applied once; result is the stored/displayed/queried title
// ============================================================================

function canonicalizeTitle(rawTitle, cinemaName, rules) {
  if (!rawTitle) return rawTitle;
  let t = rawTitle.trim();

  if (rules.titleCaseSourceWhitelist.includes(cinemaName) && isAllCaps(t)) {
    t = toTitleCase(t, rules.titleCaseAcronyms);
  }

  t = moveTrailingArticle(t);
  return t.replace(/\s+/g, ' ').trim();
}

function isAllCaps(s) {
  // A title is "all caps" if it has at least one A-Z and no a-z letters.
  return /[A-Z]/.test(s) && !/[a-z]/.test(s);
}

function toTitleCase(s, acronyms) {
  const acronymSet = new Set(acronyms.map(a => a.toUpperCase()));
  const minorWords = new Set([
    'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
    'as', 'at', 'by', 'in', 'of', 'on', 'to', 'up', 'via', 'vs', 'with'
  ]);

  const words = s.split(/(\s+)/); // keep whitespace tokens
  let wordIndex = 0;
  return words.map(token => {
    if (/^\s+$/.test(token)) return token;
    const upper = token.toUpperCase();
    const isFirstOrLast = wordIndex === 0 || wordIndex === words.filter(w => !/^\s+$/.test(w)).length - 1;
    wordIndex++;

    // Preserve acronyms exactly as configured (case-sensitive match against rule)
    const acronymMatch = acronyms.find(a => a.toUpperCase() === upper);
    if (acronymMatch) return acronymMatch;

    // Minor words (a, of, the, etc.) stay lowercase except first/last
    if (!isFirstOrLast && minorWords.has(token.toLowerCase())) {
      return token.toLowerCase();
    }

    // Default: capitalize first letter, lowercase rest. Handle hyphenated words.
    return token.toLowerCase().split('-').map(capitalize).join('-');
  }).join('');
}

function capitalize(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function moveTrailingArticle(s) {
  // "Drama, The" → "The Drama"; "Story, An" → "An Story" (rare but handled).
  // Case-preserving for the article.
  const m = s.match(/^(.+),\s+(the|a|an)\s*$/i);
  if (!m) return s;
  const body = m[1];
  const article = m[2];
  const articleCased = article.charAt(0).toUpperCase() + article.slice(1).toLowerCase();
  return `${articleCased} ${body}`;
}

// ============================================================================
// QUERY-VARIANT PHASE — multiple guesses to send to TMDB; display stays the canonical title
// ============================================================================

function generateQueryVariants(canonicalTitle, rules) {
  const variants = new Map(); // q → why (first wins on dedup)
  const add = (v, why) => {
    const cleaned = (v || '').replace(/\s+/g, ' ').trim();
    if (cleaned && cleaned.length > 1 && !variants.has(cleaned)) {
      variants.set(cleaned, why);
    }
  };

  add(canonicalTitle, 'as-is');

  const stripParen = (s) => s.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/g, '').trim();
  const stripped = stripParen(canonicalTitle);
  if (stripped !== canonicalTitle) add(stripped, 'stripped-trailing-paren');

  const prefixStripped = stripKnownFestivalPrefix(canonicalTitle, rules.festivalPrefixes);
  if (prefixStripped !== canonicalTitle) add(prefixStripped, 'stripped-festival-prefix');

  // Split on " - " (space-dash-space — won't trigger on Spider-Man or WALL-E).
  if (/\s[-–—]\s/.test(canonicalTitle)) {
    const parts = canonicalTitle.split(/\s[-–—]\s/).map(p => p.trim()).filter(Boolean);
    parts.forEach(p => add(p, 'dash-split'));
  }

  // Unaccent is applied to every base variant generated so far, so combinations
  // like "Calle Málaga (Malaga Street)" → "Calle Malaga" appear.
  const baseSoFar = Array.from(variants.entries());
  baseSoFar.forEach(([q, _why]) => {
    const u = unaccent(q);
    if (u !== q) add(u, 'unaccented');
  });

  return Array.from(variants.entries()).map(([q, why]) => ({ q, why }));
}

function stripKnownFestivalPrefix(title, prefixes) {
  for (const prefix of prefixes) {
    // Matches "GER26 Title", "MIFF Title", "MIFF24 Title", "GER Title"
    const re = new RegExp(`^${escapeRegex(prefix)}\\d{0,4}\\s+(.+)$`);
    const m = title.match(re);
    if (m) return m[1];
  }
  return title;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unaccent(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "Looks like a festival prefix but isn't in our list" — for alerting on new
// patterns. Returns the suspected prefix or null.
function detectUnknownPrefix(canonicalTitle, rules) {
  const m = canonicalTitle.match(/^([A-Z]{2,})(\d{0,4})\s+\S/);
  if (!m) return null;
  const candidate = m[1];
  if (rules.festivalPrefixes.includes(candidate)) return null;
  // Filter false positives: single ALL-CAPS title like "TENET" or "JFK" has no trailing word in the prefix position
  return candidate + (m[2] || '');
}

// ============================================================================
// SCORING — score a TMDB candidate against the canonical title
// ============================================================================

function scoreCandidate(candidate, canonicalTitle, knownYear = null) {
  // candidate.title may be a movie title; for TV candidates use candidate.name
  const candidateTitle = candidate.title || candidate.name || '';

  // 1. String similarity: normalized Levenshtein distance, unaccented + lowercase
  const a = normalizeForCompare(candidateTitle);
  const b = normalizeForCompare(canonicalTitle);
  const maxLen = Math.max(a.length, b.length) || 1;
  const similarity = 1 - (distance(a, b) / maxLen);

  // 2. Popularity bonus, bounded
  const popularity = Math.max(0, candidate.popularity || 0);
  const popularityBonus = Math.min(0.05, popularity / 1000);

  // 3. Year proximity: penalty for clearly-wrong year (so it breaks ties when
  //    similarity already saturates at 1.0). No bonus for matching, no penalty
  //    if we don't know.
  let yearPenalty = 0;
  const releaseDate = candidate.release_date || candidate.first_air_date;
  if (knownYear && releaseDate) {
    const candidateYear = parseInt(releaseDate.substring(0, 4), 10);
    if (Math.abs(candidateYear - parseInt(knownYear, 10)) > 1) {
      yearPenalty = 0.15;
    }
  }

  const total = Math.max(0, Math.min(1, similarity + popularityBonus) - yearPenalty);
  return {
    score: total,
    breakdown: { similarity, popularityBonus, yearPenalty }
  };
}

function normalizeForCompare(s) {
  return unaccent((s || '').toLowerCase())
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  loadTitleRules,
  canonicalizeTitle,
  generateQueryVariants,
  scoreCandidate,
  detectUnknownPrefix,
  // exposed for tests
  _internal: {
    isAllCaps,
    toTitleCase,
    moveTrailingArticle,
    stripKnownFestivalPrefix,
    unaccent,
    normalizeForCompare
  }
};
