# LinkedIn Finder

Job scraper + browser for new-grad SWE roles. Dual-source (LinkedIn via python-jobspy, Hiring.Cafe via HTTP), SQLite storage, static JSON export deployed to GitHub Pages.

## Architecture

**Pipeline:** `scraper.py` fetches jobs → filters (experience, degree, blocklist) → SQLite (`data/jobs.db`) → `export_json()` writes `data/jobs.json` (25 per source, newest first).

**Local dev:** `server.py` serves the frontend + REST API (`/api/jobs`, `/api/scrape`, `/api/config`) reading directly from SQLite (full dataset, paginated).

**Deployment:** GitHub Actions (`.github/workflows/scrape-and-deploy.yml`) runs the scraper hourly on weekday business hours, then deploys the repo to GitHub Pages via `actions/deploy-pages`. `data/jobs.json` is a build artifact (gitignored, not committed).

## Key Files
- `scraper.py` -- scraper + SQLite persistence + JSON export
- `server.py` -- local dev server with API endpoints
- `config.json` -- search terms, locations, filters, `max_export_per_source`, `window_days`
- `app.js` / `index.html` / `styles.css` -- vanilla JS frontend (job list, detail pane, filters)
- `data/jobs.db` -- SQLite database (gitignored)
- `data/jobs.json` -- exported JSON for static deployment (gitignored, generated at scrape time)

## Config Knobs
- `max_export_per_source` -- jobs per source in JSON export (default 25)
- `window_days` -- rolling retention window in SQLite (default 7)
- `max_experience_years` -- filter cap (default 0 = entry-level only)
- `blocked_companies` -- company exclusion list

## Consumer
The [simplifiest](https://github.com/matthewh8/simplifiest) Chrome extension fetches `data/jobs.json` from the GitHub Pages URL (`matthewh8.github.io/linkedin-finder`) and displays jobs in its tracker. See `../simplifiest/`.
