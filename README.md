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

## License

MIT
