#!/usr/bin/env python3
"""Scrape new-grad software engineering jobs from LinkedIn (python-jobspy)
and Hiring.Cafe, filter out roles wanting too much experience or from blocked
companies, and maintain a rolling window in data/jobs.json (newest first).

All tunables (search terms, locations, time windows, experience cap, blocked
companies) live in config.json next to this script."""

import argparse
import json
import math
import re
import sqlite3
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
from jobspy import scrape_jobs

ROOT = Path(__file__).parent
CONFIG_FILE = ROOT / "config.json"
DATA_FILE = ROOT / "data" / "jobs.json"
DB_FILE = ROOT / "data" / "jobs.db"

RETRY_DELAY_SECONDS = 30
HC_RETRY_DELAY_SECONDS = 5
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_START_TIME = None


def progress(msg: str, *, newline: bool = True):
    elapsed = ""
    if _START_TIME is not None:
        secs = time.time() - _START_TIME
        mins, secs = divmod(int(secs), 60)
        elapsed = f"[{mins:02d}:{secs:02d}] "
    end = "\n" if newline else ""
    print(f"{elapsed}{msg}", end=end, flush=True)


def load_config() -> dict:
    return json.loads(CONFIG_FILE.read_text())


# ---------- SQLite persistence ----------

def init_db() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_FILE))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            job_url              TEXT PRIMARY KEY,
            source               TEXT NOT NULL,
            title                TEXT,
            company              TEXT,
            location             TEXT,
            date_posted          TEXT,
            scraped_at           TEXT NOT NULL,
            description          TEXT,
            company_logo         TEXT,
            salary               TEXT,
            min_experience_years REAL
        );
        CREATE TABLE IF NOT EXISTS seen_urls (
            url        TEXT PRIMARY KEY,
            first_seen TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scrape_cursors (
            source     TEXT NOT NULL,
            search_key TEXT NOT NULL,
            offset_val INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source, search_key)
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_scraped ON jobs(scraped_at DESC);
    """)
    conn.commit()
    return conn


def migrate_from_json(conn: sqlite3.Connection):
    """One-time import of existing data/jobs.json into the DB."""
    if not DATA_FILE.exists():
        return
    row = conn.execute("SELECT COUNT(*) FROM seen_urls").fetchone()
    if row[0] > 0:
        return
    try:
        data = json.loads(DATA_FILE.read_text())
    except (json.JSONDecodeError, AttributeError):
        return
    jobs = data.get("jobs", [])
    if not jobs:
        return
    print(f"Migrating {len(jobs)} jobs from jobs.json into SQLite...", flush=True)
    for j in jobs:
        url = j.get("job_url")
        if not url:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO seen_urls (url, first_seen) VALUES (?, ?)",
            (url, j.get("scraped_at", datetime.now(timezone.utc).isoformat())))
        conn.execute(
            """INSERT OR IGNORE INTO jobs
               (job_url, source, title, company, location, date_posted,
                scraped_at, description, company_logo, salary, min_experience_years)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (url, j.get("source", "linkedin"), j.get("title"), j.get("company"),
             j.get("location"), j.get("date_posted"), j.get("scraped_at"),
             j.get("description"), j.get("company_logo"), j.get("salary"),
             j.get("min_experience_years")))
    conn.commit()
    print("  Migration complete.", flush=True)


def load_seen_urls(conn: sqlite3.Connection) -> set[str]:
    return {row[0] for row in conn.execute("SELECT url FROM seen_urls")}


def get_cursor(conn: sqlite3.Connection, source: str, search_key: str) -> int:
    row = conn.execute(
        "SELECT offset_val FROM scrape_cursors WHERE source=? AND search_key=?",
        (source, search_key)).fetchone()
    return row[0] if row else 0


def update_cursor(conn: sqlite3.Connection, source: str, search_key: str,
                  offset_val: int):
    conn.execute(
        """INSERT INTO scrape_cursors (source, search_key, offset_val)
           VALUES (?, ?, ?)
           ON CONFLICT(source, search_key) DO UPDATE SET offset_val=?""",
        (source, search_key, offset_val, offset_val))


def reset_cursors(conn: sqlite3.Connection, source: str | None = None):
    if source:
        conn.execute("DELETE FROM scrape_cursors WHERE source=?", (source,))
    else:
        conn.execute("DELETE FROM scrape_cursors")
    conn.commit()


def save_results(conn: sqlite3.Connection, entries: list[dict],
                 scraped_at: str, window_days: int):
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=window_days)).isoformat()
    for e in entries:
        url = e["job_url"]
        conn.execute(
            "INSERT OR IGNORE INTO seen_urls (url, first_seen) VALUES (?, ?)",
            (url, scraped_at))
        existing = conn.execute(
            "SELECT scraped_at FROM jobs WHERE job_url=?", (url,)).fetchone()
        sa = existing[0] if existing else scraped_at
        conn.execute(
            """INSERT OR REPLACE INTO jobs
               (job_url, source, title, company, location, date_posted,
                scraped_at, description, company_logo, salary, min_experience_years)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (url, e["source"], e.get("title"), e.get("company"),
             e.get("location"), e.get("date_posted"), sa,
             e.get("description"), e.get("company_logo"), e.get("salary"),
             e.get("min_experience_years")))
    conn.execute("DELETE FROM jobs WHERE scraped_at < ?", (cutoff,))
    conn.commit()


def export_json(conn: sqlite3.Connection, scraped_at: str,
                max_per_source: int = 25):
    sources = [r[0] for r in conn.execute(
        "SELECT DISTINCT source FROM jobs").fetchall()]
    rows = []
    for src in sources:
        rows.extend(conn.execute(
            """SELECT job_url, source, title, company, location, date_posted,
                      scraped_at, description, company_logo, salary, min_experience_years
               FROM jobs WHERE source=?
               ORDER BY scraped_at DESC, date_posted DESC LIMIT ?""",
            (src, max_per_source)).fetchall())
    cols = ["job_url", "source", "title", "company", "location", "date_posted",
            "scraped_at", "description", "company_logo", "salary",
            "min_experience_years"]
    jobs = [dict(zip(cols, row)) for row in rows]
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(
        {"last_updated": scraped_at, "jobs": jobs},
        indent=1, ensure_ascii=False))
    print(f"Exported {len(jobs)} jobs to {DATA_FILE}", flush=True)


def clean(value):
    """Normalize pandas NaN/NaT and non-string values to None or str."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if pd.isna(value):
        return None
    return value


# ---------- Experience filter ----------

_WORD_NUMS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
              "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}

# "3+ years", "2-4 yrs", "two years", "1 to 3 years" — group 1 is the low end.
_YOE_RE = re.compile(
    r"\b(\d{1,2}|" + "|".join(_WORD_NUMS) + r")"
    r"(?:\s*(?:-|–|—|\bto\b)\s*\d{1,2})?\s*\\?\+?\s*(?:years?|yrs?)\b",
    re.IGNORECASE)


_INTERN_RE = re.compile(r"\bintern(?:ship|ships|s)?\b|\bco-?op\b", re.IGNORECASE)

_ACTIVITY_RE = re.compile(
    r"(?:years?|yrs?)\s+(?:of\s+)?"
    r"(?:developing|building|working|designing|engineering|managing|"
    r"leading|programming|coding|creating|implementing|architecting|"
    r"shipping|deploying|maintaining|testing|debugging|"
    r"in\s+[a-z]|of\s+[a-z]|with\s+[a-z])",
    re.IGNORECASE)


def mentions_excess_experience(text: str, max_years: int) -> bool:
    """True if the text mentions a years-of-experience figure whose low end
    exceeds max_years (with max_years=0, "1+ years of experience" is dropped
    while "0-2 years" passes — ranges count their low end). Mentions that are
    about internship/co-op experience don't count against the job."""
    if not text:
        return False
    for m in _YOE_RE.finditer(text):
        raw = m.group(1).lower()
        low = _WORD_NUMS.get(raw)
        if low is None:
            low = int(raw)
        window = text[max(0, m.start() - 70):m.end() + 70].lower()
        if "experience" not in window and "exp." not in window:
            after = text[m.start():m.end() + 50].lower()
            if not _ACTIVITY_RE.search(after):
                continue
        if _INTERN_RE.search(window):
            continue  # "1+ years of internship experience" is fine
        if low > max_years:
            return True
    return False


# ---------- Advanced-degree filter ----------

_ADV_DEGREE_RE = re.compile(
    r"\bmaster(?:'s|s)?\b|\bmsc\b|\bm\.s\.?|\bph\.?\s?d\.?|\bdoctora(?:te|l)\b",
    re.IGNORECASE)
_DEGREE_OK_RE = re.compile(
    r"preferred|a plus|bonus|nice to have|desirable|ideally|or equivalent|"
    r"bachelor|\bb\.?s\b|\bbs/|undergraduate", re.IGNORECASE)
_DEGREE_REQ_RE = re.compile(
    r"required|requirement|must|minimum|qualification|need", re.IGNORECASE)


def requires_advanced_degree(text: str) -> bool:
    """True if the text demands a master's/PhD with no bachelor's alternative
    ("PhD in CS required"). Mentions softened by "preferred"/"bachelor's or
    master's"/"or equivalent" nearby don't count."""
    if not text:
        return False
    for m in _ADV_DEGREE_RE.finditer(text):
        window = text[max(0, m.start() - 120):m.end() + 120]
        if _DEGREE_OK_RE.search(window):
            continue
        if _DEGREE_REQ_RE.search(window):
            return True
    return False


# ---------- Salary formatting ----------

_INTERVAL_SUFFIX = {"yearly": "/yr", "monthly": "/mo", "weekly": "/wk",
                    "daily": "/day", "hourly": "/hr"}


def _fmt_amount(v: float) -> str:
    if v >= 10000 and v % 500 == 0:
        k = v / 1000
        return f"${k:g}K"
    if v >= 1000:
        return f"${v:,.0f}"
    s = f"${v:,.2f}"
    return s[:-3] if s.endswith(".00") else s


def format_salary(min_a, max_a, interval) -> str | None:
    suffix = _INTERVAL_SUFFIX.get(interval or "yearly", "")
    lo = _fmt_amount(min_a) if min_a else None
    hi = _fmt_amount(max_a) if max_a else None
    if lo and hi and lo != hi:
        return f"{lo} – {hi}{suffix}"
    if lo or hi:
        return f"{lo or hi}{suffix}"
    return None


# Conservative fallback: "$120,000 - $150,000" or "$45.50/hour" style strings
# inside a job description.
_DESC_SALARY_RE = re.compile(
    r"\$\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d{2})?(?=\s*(?:-|–|to|/|per)))"
    r"(?:\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d{2})?))?",
    re.IGNORECASE)


def salary_from_description(desc: str) -> str | None:
    if not desc:
        return None
    m = _DESC_SALARY_RE.search(desc)
    if not m:
        return None
    lo = float(m.group(1).replace(",", ""))
    hi = float(m.group(2).replace(",", "")) if m.group(2) else None
    interval = "hourly" if lo < 1000 else "yearly"
    return format_salary(lo, hi, interval)


# ---------- LinkedIn (python-jobspy) ----------

def run_linkedin_search(search_term: str, location: str, hours_old: int,
                        results_wanted: int, offset: int = 0,
                        step: str = "") -> pd.DataFrame:
    """Run one LinkedIn search, retrying once with backoff. Returns an empty
    DataFrame on total failure so a single bad search never kills the run."""
    short_loc = location.split(",")[0]
    for attempt in (1, 2, 3):
        try:
            if attempt == 1:
                progress(f"  {step}Searching \"{search_term}\" in {short_loc} "
                         f"(offset {offset})...")
            else:
                delay = RETRY_DELAY_SECONDS * (2 ** (attempt - 2))
                progress(f"  {step}Retrying \"{search_term}\" in {short_loc} "
                         f"(attempt {attempt}, waiting {delay}s)...")
                time.sleep(delay)
            df = scrape_jobs(
                site_name=["linkedin"],
                search_term=search_term,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                linkedin_fetch_description=True,
                offset=offset,
            )
            progress(f"    -> {len(df)} jobs found")
            return df
        except Exception as e:
            progress(f"    -> attempt {attempt} failed: {e}")
    return pd.DataFrame()


def _build_linkedin_entry(row, scraped_at: str) -> dict | None:
    job_url = clean(row.get("job_url"))
    if not job_url:
        return None
    description = clean(row.get("description"))
    salary = format_salary(clean(row.get("min_amount")),
                           clean(row.get("max_amount")),
                           clean(row.get("interval")))
    if not salary:
        salary = salary_from_description(description or "")
    date_posted = clean(row.get("date_posted"))
    return {
        "source": "linkedin",
        "title": clean(row.get("title")),
        "company": clean(row.get("company")),
        "location": clean(row.get("location")),
        "date_posted": str(date_posted) if date_posted is not None else None,
        "scraped_at": scraped_at,
        "job_url": job_url,
        "description": description,
        "company_logo": clean(row.get("company_logo")),
        "salary": salary,
        "min_experience_years": None,
    }


def scrape_linkedin(cfg: dict, scraped_at: str, hours_override: int | None,
                    seen_urls: set[str],
                    batch_size: int | None = None,
                    filter_cfg: dict | None = None,
                    ) -> list[dict]:
    """Fetch LinkedIn jobs, targeting batch_size unique (unseen) results per
    search pair.  Automatically paginates until the target is met or results
    are exhausted.  Entries that fail passes_filters() do not count toward
    the target."""
    hours_old = hours_override or cfg.get("hours_old", 24)
    target = batch_size or cfg.get("batch_size", 15)
    api_batch = max(target * 2, 30)
    terms = cfg.get("search_terms", [])
    locations = cfg.get("locations", [])
    total_searches = len(terms) * len(locations)
    fc = filter_cfg or {}

    collected_urls = set(seen_urls)
    lock = threading.Lock()

    def fetch_pair(term, loc, step):
        offset = 0
        max_offset = api_batch * 5
        entries = []
        while len(entries) < target and offset < max_offset:
            df = run_linkedin_search(term, loc, hours_old,
                                     api_batch, offset, step)
            if df.empty:
                break
            before = len(entries)
            for _, row in df.iterrows():
                url = clean(row.get("job_url"))
                if not url:
                    continue
                with lock:
                    if url in collected_urls:
                        continue
                    collected_urls.add(url)
                entry = _build_linkedin_entry(row, scraped_at)
                if not entry:
                    continue
                if not passes_filters(entry, **fc):
                    continue
                entries.append(entry)
                if len(entries) >= target:
                    break
            if len(df) < api_batch:
                break
            if len(entries) == before:
                break
            offset += len(df)
        progress(f"  {step}{loc}: {len(entries)} unique jobs")
        return entries

    searches = []
    for i, term in enumerate(terms):
        for j, loc in enumerate(locations):
            num = i * len(locations) + j + 1
            step = f"[{num}/{total_searches}] "
            searches.append((term, loc, step))

    all_entries = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(fetch_pair, term, loc, step): (term, loc)
            for term, loc, step in searches
        }
        for future in as_completed(futures):
            all_entries.extend(future.result())

    return all_entries


# ---------- Hiring.Cafe ----------

HC_MAX_RETRIES = 3


def fetch_hiringcafe_page(search_state: dict, page: int) -> dict | None:
    """Fetch one SSR search page and return its pageProps, or None on failure.
    Hiring.Cafe embeds results in the page's __NEXT_DATA__ blob."""
    url = ("https://hiring.cafe/?searchState="
           + urllib.parse.quote(json.dumps(search_state)) + f"&page={page}")
    for attempt in range(1, HC_MAX_RETRIES + 1):
        try:
            if attempt > 1:
                delay = HC_RETRY_DELAY_SECONDS * (2 ** (attempt - 2))
                progress(f"  Retrying page {page} (attempt {attempt}, "
                         f"waiting {delay}s)...")
                time.sleep(delay)
            r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=60)
            r.raise_for_status()
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">'
                          r'(.*?)</script>', r.text, re.S)
            if not m:
                raise ValueError("no __NEXT_DATA__ in response")
            return json.loads(m.group(1))["props"]["pageProps"]
        except Exception as e:
            progress(f"    -> page {page} attempt {attempt} failed: {e}")
    return None


def hc_salary(v5: dict) -> str | None:
    if v5.get("yearly_min_compensation") or v5.get("yearly_max_compensation"):
        return format_salary(v5.get("yearly_min_compensation"),
                             v5.get("yearly_max_compensation"), "yearly")
    if v5.get("hourly_min_compensation") or v5.get("hourly_max_compensation"):
        return format_salary(v5.get("hourly_min_compensation"),
                             v5.get("hourly_max_compensation"), "hourly")
    return None


def hc_description(v5: dict, company: dict) -> str:
    """Hiring.Cafe search results carry structured fields but no full posting
    text, so assemble a readable markdown summary from what we have."""
    parts = []
    summary = v5.get("requirements_summary")
    if summary:
        parts.append("### Requirements\n" + summary)
    activities = v5.get("role_activities") or []
    if activities:
        parts.append("### Role activities\n" +
                     "\n".join(f"- {a}" for a in activities))
    tools = v5.get("technical_tools") or []
    if tools:
        parts.append("### Tech mentioned\n" + ", ".join(tools))
    perks = []
    for field, label in [("visa_sponsorship", "Visa sponsorship"),
                         ("401k_matching", "401k matching"),
                         ("tuition_reimbursement", "Tuition reimbursement"),
                         ("relocation_assistance", "Relocation assistance"),
                         ("generous_paid_time_off", "Generous PTO"),
                         ("four_day_work_week", "4-day work week")]:
        if v5.get(field) is True:
            perks.append(label)
    if perks:
        parts.append("### Perks mentioned\n" + ", ".join(perks))
    facts = []
    if v5.get("workplace_type"):
        facts.append(f"**Workplace:** {v5['workplace_type']}")
    if v5.get("commitment"):
        facts.append(f"**Commitment:** {', '.join(v5['commitment'])}")
    if v5.get("seniority_level"):
        facts.append(f"**Seniority:** {v5['seniority_level']}")
    yoe = v5.get("min_industry_and_role_yoe")
    if yoe is not None and not v5.get("is_min_industry_and_role_yoe_not_mentioned"):
        facts.append(f"**Min experience:** {yoe:g} year{'s' if yoe != 1 else ''}")
    if company.get("nb_employees"):
        facts.append(f"**Company size:** {company['nb_employees']} employees")
    if company.get("tagline"):
        facts.append(f"**About:** {company['tagline']}")
    if facts:
        parts.insert(0, "\n\n".join(facts))
    parts.append("*Summary generated from Hiring.Cafe structured data — "
                 "see the full posting via the apply link.*")
    return "\n\n".join(parts)


def hc_logo(company: dict) -> str | None:
    homepage = company.get("homepage_uri")
    if not homepage:
        return None
    domain = urllib.parse.urlparse(homepage).netloc or homepage
    if not domain:
        return None
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=128"


def scrape_hiringcafe(cfg: dict, scraped_at: str,
                      start_page: int = 0,
                      pages_to_fetch: int | None = None,
                      ) -> tuple[list[dict], int]:
    """Returns (entries, next_page) where next_page is the page to resume from."""
    search_state = dict(cfg.get("search_state", {}))
    search_state["dateFetchedPastNDays"] = cfg.get("days_old", 1)
    max_pages = pages_to_fetch or cfg.get("max_pages", 10)

    entries, seen = [], set()
    last_page = start_page
    batch_size = 3
    page = start_page

    while page < start_page + max_pages:
        batch_end = min(page + batch_size, start_page + max_pages)
        batch_pages = list(range(page, batch_end))
        progress(f"  Fetching pages {batch_pages[0]}–{batch_pages[-1]} "
                 f"({page - start_page + 1}–{batch_end - start_page}/{max_pages})...")

        with ThreadPoolExecutor(max_workers=batch_size) as pool:
            future_to_page = {
                pool.submit(fetch_hiringcafe_page, search_state, p): p
                for p in batch_pages
            }
            results = {}
            for future in as_completed(future_to_page):
                p = future_to_page[future]
                results[p] = future.result()

        stop = False
        for p in batch_pages:
            props = results[p]
            if props is None:
                progress(f"    -> page {p} returned no data, skipping")
                continue
            hits = props.get("ssrHits") or []
            total_count = props.get("ssrTotalCount", "?")
            progress(f"    -> page {p}: {len(hits)} jobs (total available: {total_count})")
            for hit in hits:
                job_url = hit.get("apply_url")
                if not job_url or job_url in seen or hit.get("is_expired"):
                    continue
                seen.add(job_url)
                v5 = hit.get("v5_processed_job_data") or {}
                if "Required" in (v5.get("masters_degree_requirement"),
                                  v5.get("doctorate_degree_requirement")):
                    continue
                company = hit.get("enriched_company_data") or {}
                info = hit.get("job_information") or {}
                location = v5.get("formatted_workplace_location") or ""
                if v5.get("workplace_type") == "Remote" and \
                        "remote" not in location.lower():
                    location = (location + " (Remote)").strip()
                publish = v5.get("estimated_publish_date")
                yoe = v5.get("min_industry_and_role_yoe")
                if v5.get("is_min_industry_and_role_yoe_not_mentioned"):
                    yoe = None
                entries.append({
                    "source": "hiringcafe",
                    "title": info.get("title") or v5.get("core_job_title"),
                    "company": company.get("name") or hit.get("board_token"),
                    "location": location or None,
                    "date_posted": publish[:10] if publish else None,
                    "scraped_at": scraped_at,
                    "job_url": job_url,
                    "description": hc_description(v5, company),
                    "company_logo": hc_logo(company),
                    "salary": hc_salary(v5),
                    "min_experience_years": yoe,
                })
            last_page = p + 1
            if props.get("ssrIsLastPage") or not hits:
                stop = True
                break

        if stop:
            break
        page = batch_end

    return entries, last_page


# ---------- Filtering / persistence ----------

_SALARY_NUM_RE = re.compile(r"\$([\d,]+(?:\.\d+)?)(K?)")


def _parse_salary_bounds(salary_str: str) -> tuple[float | None, float | None]:
    """Extract (min_annual, max_annual) dollars from a formatted salary string."""
    if not salary_str:
        return None, None
    amounts = []
    for m in _SALARY_NUM_RE.finditer(salary_str):
        val = float(m.group(1).replace(",", ""))
        if m.group(2) == "K":
            val *= 1000
        amounts.append(val)
    if not amounts:
        return None, None
    if "/hr" in salary_str:
        amounts = [a * 2080 for a in amounts]
    elif "/mo" in salary_str:
        amounts = [a * 12 for a in amounts]
    elif "/wk" in salary_str:
        amounts = [a * 52 for a in amounts]
    elif "/day" in salary_str:
        amounts = [a * 260 for a in amounts]
    return amounts[0], amounts[-1]


def passes_filters(entry: dict, max_years: int, blocked: set[str],
                   blocked_keywords: list[str] | None = None,
                   max_salary: float | None = None,
                   max_min_salary: float | None = None) -> bool:
    if (entry.get("company") or "").strip().lower() in blocked:
        return False
    title = (entry.get("title") or "").lower()
    if blocked_keywords:
        for kw in blocked_keywords:
            if kw in title:
                return False
    yoe = entry.get("min_experience_years")
    if yoe is not None and yoe > max_years:
        return False
    if max_salary is not None or max_min_salary is not None:
        lo, hi = _parse_salary_bounds(entry.get("salary"))
        if max_salary is not None and hi is not None and hi > max_salary:
            return False
        if max_min_salary is not None and lo is not None and lo >= max_min_salary:
            return False
    text = " ".join(filter(None, [entry.get("title"), entry.get("description")]))
    if mentions_excess_experience(text, max_years):
        return False
    if requires_advanced_degree(text):
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours-old", type=int, default=None,
                        help="override linkedin hours_old from config.json")
    parser.add_argument("--batch-size", type=int, default=None,
                        help="override linkedin batch_size from config.json")
    parser.add_argument("--continue", dest="resume", action="store_true",
                        help="resume from stored offsets instead of starting fresh")
    parser.add_argument("--skip-linkedin", action="store_true")
    parser.add_argument("--skip-hiringcafe", action="store_true")
    parser.add_argument("--source", action="append",
                        choices=["linkedin", "hiringcafe"],
                        help="run only these sources (ignores enabled setting)")
    args = parser.parse_args()

    global _START_TIME
    _START_TIME = time.time()

    cfg = load_config()
    now = datetime.now(timezone.utc)
    scraped_at = now.isoformat(timespec="seconds")

    sources = []
    hc_cfg = cfg.get("hiringcafe", {})
    li_cfg = cfg.get("linkedin", {})
    if args.source:
        if "hiringcafe" in args.source and not args.skip_hiringcafe:
            sources.append("Hiring.Cafe")
        if "linkedin" in args.source and not args.skip_linkedin:
            sources.append("LinkedIn")
    else:
        if hc_cfg.get("enabled", True) and not args.skip_hiringcafe:
            sources.append("Hiring.Cafe")
        if li_cfg.get("enabled", True) and not args.skip_linkedin:
            sources.append("LinkedIn")

    progress(f"Starting scrape at {now.strftime('%Y-%m-%d %H:%M UTC')}")
    progress(f"Sources: {', '.join(sources) or 'none'}")

    conn = init_db()
    migrate_from_json(conn)
    seen_urls = load_seen_urls(conn)
    progress(f"Database loaded ({len(seen_urls)} previously seen URLs)")

    if not args.resume:
        reset_cursors(conn)

    max_years = cfg.get("max_experience_years", 1)
    blocked = {c.strip().lower() for c in cfg.get("blocked_companies", [])}
    blocked_kw = [k.lower() for k in cfg.get("blocked_title_keywords", [])]
    filter_cfg = dict(max_years=max_years, blocked=blocked,
                      blocked_keywords=blocked_kw,
                      max_salary=cfg.get("max_salary"),
                      max_min_salary=cfg.get("max_min_salary"))

    new_entries = []

    if "Hiring.Cafe" in sources:
        start_page = get_cursor(conn, "hiringcafe", "default") if args.resume else 0
        max_pages = hc_cfg.get("max_pages", 10)
        progress(f"--- Hiring.Cafe (pages {start_page}..{start_page + max_pages - 1}) ---")
        hc_entries, next_page = scrape_hiringcafe(hc_cfg, scraped_at,
                                                  start_page=start_page)
        progress(f"Hiring.Cafe done: {len(hc_entries)} jobs collected")
        new_entries += hc_entries
        update_cursor(conn, "hiringcafe", "default", next_page)

    if "LinkedIn" in sources:
        terms = li_cfg.get("search_terms", [])
        locs = li_cfg.get("locations", [])
        target = args.batch_size or li_cfg.get("batch_size", 15)
        progress(f"--- LinkedIn ({len(terms)} terms x {len(locs)} locations, "
                 f"target {target} unique per search) ---")
        li_entries = scrape_linkedin(
            li_cfg, scraped_at, args.hours_old, seen_urls,
            batch_size=args.batch_size, filter_cfg=filter_cfg)
        progress(f"LinkedIn done: {len(li_entries)} jobs collected")
        new_entries += li_entries

    conn.commit()

    progress(f"--- Filtering ---")
    before_dedup = len(new_entries)
    new_entries = [e for e in new_entries if e["job_url"] not in seen_urls]
    progress(f"Dedup: {before_dedup} fetched, {before_dedup - len(new_entries)} "
             f"already seen, {len(new_entries)} new")

    kept_entries = [e for e in new_entries
                    if passes_filters(e, **filter_cfg)]
    filtered_out = len(new_entries) - len(kept_entries)
    progress(f"Filters: {filtered_out} removed (experience/degree/blocklist), "
             f"{len(kept_entries)} kept")

    if kept_entries:
        save_results(conn, kept_entries, scraped_at, cfg.get("window_days", 7))
        export_json(conn, scraped_at, cfg.get("max_export_per_source", 25))
    else:
        progress("No new jobs to save, skipping export")
    conn.close()

    elapsed = time.time() - _START_TIME
    mins, secs = divmod(int(elapsed), 60)
    progress(f"Done in {mins}m {secs}s")


if __name__ == "__main__":
    main()
