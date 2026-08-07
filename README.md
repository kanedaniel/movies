# Melbourne Movies Today

A single-serving webpage that aggregates daily movie times from Melbourne's independent cinemas, enriched with film synopses from TMDB.

## Cinemas Covered

- ACMI (Fed Square)
- Brunswick Picture House
- Eclipse Cinema
- Cinema Nova (Carlton)
- Lido Cinemas (Hawthorn)
- Hoyts Melbourne Central
- The Astor Theatre (St Kilda)

## Setup

1. Add your TMDB API key as a GitHub secret named `TMDB_API_KEY`
2. Enable GitHub Pages (Settings → Pages → Deploy from main branch)
3. Run the workflow manually, or wait for the 5am AEST daily run

## How It Works

A GitHub Action runs daily, scrapes all cinema sites with Puppeteer, fetches film info from TMDB, and commits the results to `data/sessions.json`. The static HTML page displays the data.

## Title resolver

Cinema titles come in many shapes (`THE DRAMA`, `GER26 Berlin Hero`, `Top Gun: Maverick (Top Gun Day Re-release)`, `Calle Málaga (Malaga Street)`, `Drama, the`). The scraper normalizes them via a two-phase pipeline (`src/title-pipeline.js`) and falls back through a query cascade when TMDB doesn't find a confident match. Cases that need a human are written to `data/needs-review.json`; the GitHub Action upserts a pinned issue from that file, so a notification arrives the day a new shape appears.

Resolve each entry by editing one of:

- `data/tmdb-overrides.json` — map a specific scraped title to a TMDB id (or `{ id, type: "tv" }` for TV shows)
- `data/title-rules.json` — extend `festivalPrefixes` (e.g. `MIFF`, `JFF`), `titleCaseAcronyms` (tokens that stay all-caps), or `titleCaseSourceWhitelist` (cinemas whose scraped titles arrive in `ALL CAPS`)

Commit and push; the entry disappears on the next scrape.

Run `npm run test:title-pipeline` to validate the pipeline locally.

## License

MIT
