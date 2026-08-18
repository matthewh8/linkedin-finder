# New Grad SWE Job Board

A self-updating job board for **new-grad software engineering roles**, scraped
from LinkedIn and [Hiring.Cafe](https://hiring.cafe) every 2 hours and
published as a static site on GitHub Pages.

- **Scraper** — `scraper.py` pulls from two sources:
  - **LinkedIn** via [python-jobspy](https://github.com/speedyapply/JobSpy),
    searching the terms and locations in `config.json`.
  - **Hiring.Cafe** via its search page (results are read from the page's
    embedded JSON), using the saved filter in `config.json` →
    `hiringcafe.search_state` (entry-level, transparent salaries, CS degree,
    US-wide by default).

  Jobs are filtered before saving: anything **mentioning ≥ 2 years of
  experience** (configurable) or from a **blocked company** is dropped.
  Results keep a rolling 7-day window in `data/jobs.json`, deduped by URL,
  with salary extracted where available.
- **Frontend** — a dependency-free static site (`index.html`, `styles.css`,
  `app.js`) styled after LinkedIn's job search page: job list on the left
  (with a source badge on each company logo and a highlighted salary pill),
  detail pane on the right, location filter chips (driven by `config.json`),
  keyword search, **mark-as-applied** tracking (applied jobs gray out; a
  "Hide applied / Show all" toggle filters them), and **block company**
  (hides all of a company's listings, manageable via the "Blocked" panel).
  Applied marks and blocks are saved in your browser's `localStorage`, so
  they persist across visits on the same browser/device.
- **Automation** — a GitHub Actions workflow re-scrapes every 2 hours,
  commits the fresh `data/jobs.json`, and redeploys the site to GitHub Pages.

## Quick start (local)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# One scrape (both sources, windows from config.json):
python scraper.py

# Handy flags:
python scraper.py --skip-linkedin      # Hiring.Cafe only (fast)
python scraper.py --skip-hiringcafe    # LinkedIn only
python scraper.py --hours-old 72       # override LinkedIn window (seeding)

# Serve the site locally (fetch() needs a server, not file://):
python -m http.server 8000
# then open http://localhost:8000
```

## Deploying to GitHub Pages

1. **Create the repo and push:**

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create <your-username>/newgrad-jobs --public --source . --push
   # (or create an empty repo on github.com and `git remote add` + `git push`)
   ```

2. **Enable GitHub Pages via Actions:** in the repo go to
   **Settings → Pages → Build and deployment → Source** and select
   **GitHub Actions**.

3. **Allow the workflow to commit:** in
   **Settings → Actions → General → Workflow permissions**, select
   **Read and write permissions**.

4. **Kick off the first run:** go to the **Actions** tab, open
   *Scrape jobs and deploy*, and click **Run workflow**. After it finishes,
   your board is live at `https://<your-username>.github.io/newgrad-jobs/`.

   The workflow then runs automatically every 2 hours. (GitHub may pause
   scheduled workflows on repos with no activity for 60 days — a manual run
   re-enables them.)

## Customizing — everything lives in `config.json`

| Setting | Default | Meaning |
|---|---|---|
| `max_experience_years` | `1` | drop jobs mentioning more required years than this ("0-2 yrs" passes — the range's low end counts; "2+ yrs" is dropped) |
| `blocked_companies` | `[]` | company names to drop at scrape time (the UI's Block button is separate, per-browser) |
| `location_filters` | CA/TX/NY/Seattle/Remote | the filter chips; `matchers` are lowercase substrings tested against each job's location |
| `window_days` | `7` | how long jobs stay on the board |
| `linkedin.search_terms` / `.locations` | new grad, entry level × 4 regions | one LinkedIn search per term per location |
| `linkedin.hours_old` | `24` | only fetch LinkedIn postings newer than this |
| `linkedin.results_wanted` | `50` | max results per LinkedIn search |
| `hiringcafe.days_old` | `1` | Hiring.Cafe posting window (1 = last 24h) |
| `hiringcafe.search_state` | entry-level US filter | the saved Hiring.Cafe filter — build one on hiring.cafe, copy the `searchState` JSON out of the URL, and paste it here |
| `hiringcafe.max_pages` | `10` | safety cap on result pages per run |

- **Schedule:** edit the `cron:` line in
  `.github/workflows/scrape-and-deploy.yml` (e.g. `"0 */4 * * *"` for every
  4 hours). Keep it at or under the source windows so nothing falls in the
  gap between runs.
- The frontend reads `config.json` too, so chip changes need no code edits.

## Notes & caveats

- Applied/blocked state lives in `localStorage` — per browser, per device.
  Clearing site data resets it. (To block a company permanently for the
  scraper too, add it to `blocked_companies` in `config.json`.)
- Hiring.Cafe search results don't include the full posting text, so those
  descriptions are structured summaries (requirements, activities, tech,
  perks); the apply button goes to the company's real application page.
- LinkedIn rate-limits aggressive scraping. The scraper retries each search
  once with a 30s backoff and always saves whatever it managed to fetch, so
  a partially rate-limited run degrades gracefully instead of failing.
- This project is for personal job-hunting use. Scraping LinkedIn is against
  their Terms of Service, so keep the volume modest (the defaults are small)
  and be aware they may block requests at any time.
- The site deliberately avoids LinkedIn's and Hiring.Cafe's logos and
  wordmarks; sources are marked with neutral badges.
