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
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
from jobspy import scrape_jobs

ROOT = Path(__file__).parent
CONFIG_FILE = ROOT / "config.json"
DATA_FILE = ROOT / "data" / "jobs.json"

RETRY_DELAY_SECONDS = 30
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def load_config() -> dict:
    return json.loads(CONFIG_FILE.read_text())


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
    r"(?:\s*(?:-|–|—|\bto\b)\s*\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b",
    re.IGNORECASE)


_INTERN_RE = re.compile(r"\bintern(?:ship|ships|s)?\b|\bco-?op\b", re.IGNORECASE)


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
            continue  # "2 year degree", "401k after 1 year", etc.
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
                        results_wanted: int) -> pd.DataFrame:
    """Run one LinkedIn search, retrying once with backoff. Returns an empty
    DataFrame on total failure so a single bad search never kills the run."""
    for attempt in (1, 2):
        try:
            df = scrape_jobs(
                site_name=["linkedin"],
                search_term=search_term,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                linkedin_fetch_description=True,
            )
            print(f"  [{search_term!r} @ {location!r}] {len(df)} jobs")
            return df
        except Exception as e:
            print(f"  [{search_term!r} @ {location!r}] attempt {attempt} failed: {e}")
            if attempt == 1:
                time.sleep(RETRY_DELAY_SECONDS)
    return pd.DataFrame()


def scrape_linkedin(cfg: dict, scraped_at: str, hours_override: int | None) -> list[dict]:
    hours_old = hours_override or cfg.get("hours_old", 24)
    frames = []
    for term in cfg.get("search_terms", []):
        for loc in cfg.get("locations", []):
            frames.append(run_linkedin_search(
                term, loc, hours_old, cfg.get("results_wanted", 50)))
    non_empty = [f for f in frames if not f.empty]
    if not non_empty:
        return []
    merged = pd.concat(non_empty, ignore_index=True)
    merged = merged.drop_duplicates(subset="job_url", keep="first")

    entries = []
    for _, row in merged.iterrows():
        job_url = clean(row.get("job_url"))
        if not job_url:
            continue
        date_posted = clean(row.get("date_posted"))
        description = clean(row.get("description"))
        salary = format_salary(clean(row.get("min_amount")),
                               clean(row.get("max_amount")),
                               clean(row.get("interval")))
        if not salary:
            salary = salary_from_description(description or "")
        entries.append({
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
        })
    return entries


# ---------- Hiring.Cafe ----------

def fetch_hiringcafe_page(search_state: dict, page: int) -> dict | None:
    """Fetch one SSR search page and return its pageProps, or None on failure.
    Hiring.Cafe embeds results in the page's __NEXT_DATA__ blob."""
    url = ("https://hiring.cafe/?searchState="
           + urllib.parse.quote(json.dumps(search_state)) + f"&page={page}")
    for attempt in (1, 2):
        try:
            r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=60)
            r.raise_for_status()
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">'
                          r'(.*?)</script>', r.text, re.S)
            if not m:
                raise ValueError("no __NEXT_DATA__ in response")
            return json.loads(m.group(1))["props"]["pageProps"]
        except Exception as e:
            print(f"  [hiring.cafe page {page}] attempt {attempt} failed: {e}")
            if attempt == 1:
                time.sleep(RETRY_DELAY_SECONDS)
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


def scrape_hiringcafe(cfg: dict, scraped_at: str) -> list[dict]:
    search_state = dict(cfg.get("search_state", {}))
    search_state["dateFetchedPastNDays"] = cfg.get("days_old", 1)

    entries, seen = [], set()
    for page in range(cfg.get("max_pages", 10)):
        props = fetch_hiringcafe_page(search_state, page)
        if props is None:
            break
        hits = props.get("ssrHits") or []
        print(f"  [hiring.cafe page {page}] {len(hits)} jobs "
              f"(total reported: {props.get('ssrTotalCount')})")
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
        if props.get("ssrIsLastPage") or not hits:
            break
        time.sleep(1)
    return entries


# ---------- Filtering / persistence ----------

def passes_filters(entry: dict, max_years: int, blocked: set[str]) -> bool:
    if (entry.get("company") or "").strip().lower() in blocked:
        return False
    yoe = entry.get("min_experience_years")
    if yoe is not None and yoe > max_years:
        return False
    text = " ".join(filter(None, [entry.get("title"), entry.get("description")]))
    if mentions_excess_experience(text, max_years):
        return False
    if requires_advanced_degree(text):
        return False
    return True


def load_existing() -> list[dict]:
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text()).get("jobs", [])
        except (json.JSONDecodeError, AttributeError):
            print("  warning: existing jobs.json unreadable, starting fresh")
    return []


def within_window(job: dict, cutoff: datetime) -> bool:
    try:
        return datetime.fromisoformat(job["scraped_at"]) >= cutoff
    except (KeyError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours-old", type=int, default=None,
                        help="override linkedin hours_old from config.json")
    parser.add_argument("--skip-linkedin", action="store_true")
    parser.add_argument("--skip-hiringcafe", action="store_true")
    args = parser.parse_args()

    cfg = load_config()
    now = datetime.now(timezone.utc)
    scraped_at = now.isoformat(timespec="seconds")

    new_entries = []
    hc_cfg = cfg.get("hiringcafe", {})
    if hc_cfg.get("enabled", True) and not args.skip_hiringcafe:
        print("Scraping Hiring.Cafe...")
        new_entries += scrape_hiringcafe(hc_cfg, scraped_at)
    li_cfg = cfg.get("linkedin", {})
    if li_cfg.get("enabled", True) and not args.skip_linkedin:
        print("Scraping LinkedIn...")
        new_entries += scrape_linkedin(li_cfg, scraped_at, args.hours_old)

    max_years = cfg.get("max_experience_years", 1)
    blocked = {c.strip().lower() for c in cfg.get("blocked_companies", [])}
    kept_entries = [e for e in new_entries
                    if passes_filters(e, max_years, blocked)]
    print(f"Fetched {len(new_entries)} unique jobs, "
          f"{len(kept_entries)} after experience/blocklist filters")

    existing = load_existing()
    # Re-fetched jobs keep their original scraped_at so "N hours ago" and
    # feed order stay stable across runs.
    first_seen = {j.get("job_url"): j.get("scraped_at") for j in existing}
    for e in kept_entries:
        prior = first_seen.get(e["job_url"])
        if prior:
            e["scraped_at"] = prior
    seen_urls = {j["job_url"] for j in kept_entries}
    kept_old = [j for j in existing if j.get("job_url") not in seen_urls
                and passes_filters(j, max_years, blocked)]

    cutoff = now - timedelta(days=cfg.get("window_days", 7))
    all_jobs = kept_entries + [j for j in kept_old if within_window(j, cutoff)]
    all_jobs.sort(key=lambda j: (j.get("scraped_at") or "",
                                 j.get("date_posted") or ""), reverse=True)

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(
        {"last_updated": scraped_at, "jobs": all_jobs},
        indent=1, ensure_ascii=False,
    ))
    print(f"Wrote {len(all_jobs)} jobs to {DATA_FILE}")


if __name__ == "__main__":
    main()
