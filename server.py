#!/usr/bin/env python3
"""Dev server: serves the static frontend and exposes API endpoints for
paginated job queries and on-demand scraping."""

import http.server
import json
import sqlite3
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = 8000
ROOT = Path(__file__).parent
SCRAPER = ROOT / "scraper.py"
DB_FILE = ROOT / "data" / "jobs.db"
CONFIG_FILE = ROOT / "config.json"


def load_config():
    return json.loads(CONFIG_FILE.read_text())


def get_db():
    conn = sqlite3.connect(str(DB_FILE), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    return conn


def location_matchers(config):
    return {f["label"]: f["matchers"]
            for f in config.get("location_filters", [])}


def _deep_merge(base: dict, updates: dict):
    for key, value in updates.items():
        if (key in base and isinstance(base[key], dict)
                and isinstance(value, dict)):
            _deep_merge(base[key], value)
        else:
            base[key] = value


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._json_response({"error": message}, status)

    # ---------- Routing ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/jobs":
            self._handle_jobs(parsed)
        elif parsed.path == "/api/stats":
            self._handle_stats()
        elif parsed.path == "/api/config":
            self._handle_get_config()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/scrape":
            self._handle_scrape_source()
        elif self.path == "/api/fetch-more":
            self._handle_scrape(resume=True)
        elif self.path == "/api/fresh-update":
            self._handle_scrape(resume=False)
        elif self.path == "/api/config":
            self._handle_post_config()
        else:
            self.send_error(404)

    # ---------- GET /api/jobs ----------

    def _handle_jobs(self, parsed):
        if not DB_FILE.exists():
            self._json_response({"jobs": [], "page": 1, "per_page": 20,
                                 "total": 0, "has_more": False,
                                 "last_updated": None})
            return

        params = parse_qs(parsed.query)
        page = max(1, int(params.get("page", ["1"])[0]))
        per_page = min(100, max(1, int(params.get("per_page", ["20"])[0])))
        q = params.get("q", [""])[0].strip()
        location_labels = [s.strip() for s in
                           params.get("location", [""])[0].split(",") if s.strip()]
        source = params.get("source", [""])[0].strip()

        where, args = [], []

        if q:
            where.append("(LOWER(title) LIKE ? OR LOWER(company) LIKE ?)")
            needle = f"%{q.lower()}%"
            args.extend([needle, needle])

        if source:
            where.append("source = ?")
            args.append(source)

        if location_labels:
            cfg = load_config()
            matchers = location_matchers(cfg)
            loc_clauses = []
            for label in location_labels:
                for m in matchers.get(label, []):
                    loc_clauses.append("LOWER(location) LIKE ?")
                    args.append(f"%{m}%")
            if loc_clauses:
                where.append(f"({' OR '.join(loc_clauses)})")

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        offset = (page - 1) * per_page

        conn = get_db()
        try:
            total = conn.execute(
                f"SELECT COUNT(*) FROM jobs{where_sql}", args).fetchone()[0]
            rows = conn.execute(
                f"""SELECT job_url, source, title, company, location, date_posted,
                           scraped_at, description, company_logo, salary,
                           min_experience_years
                    FROM jobs{where_sql}
                    ORDER BY scraped_at DESC, date_posted DESC
                    LIMIT ? OFFSET ?""",
                args + [per_page, offset]).fetchall()
            last_row = conn.execute(
                "SELECT MAX(scraped_at) FROM jobs").fetchone()
            last_updated = last_row[0] if last_row else None
        finally:
            conn.close()

        cols = ["job_url", "source", "title", "company", "location",
                "date_posted", "scraped_at", "description", "company_logo",
                "salary", "min_experience_years"]
        jobs = [dict(zip(cols, row)) for row in rows]
        self._json_response({
            "jobs": jobs,
            "page": page,
            "per_page": per_page,
            "total": total,
            "has_more": (page * per_page) < total,
            "last_updated": last_updated,
        })

    # ---------- GET /api/stats ----------

    def _handle_stats(self):
        if not DB_FILE.exists():
            self._json_response({"total_jobs": 0, "total_seen": 0,
                                 "by_source": {}, "last_updated": None})
            return
        conn = get_db()
        try:
            total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
            seen = conn.execute("SELECT COUNT(*) FROM seen_urls").fetchone()[0]
            sources = {}
            for row in conn.execute(
                    "SELECT source, COUNT(*) FROM jobs GROUP BY source"):
                sources[row[0]] = row[1]
            last = conn.execute("SELECT MAX(scraped_at) FROM jobs").fetchone()
        finally:
            conn.close()
        self._json_response({
            "total_jobs": total,
            "total_seen": seen,
            "by_source": sources,
            "last_updated": last[0] if last else None,
        })

    # ---------- GET/POST /api/config ----------

    def _handle_get_config(self):
        try:
            self._json_response(load_config())
        except Exception as e:
            self._error(500, f"Failed to read config: {e}")

    def _handle_post_config(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            updates = json.loads(body)
        except (ValueError, json.JSONDecodeError) as e:
            self._error(400, f"Invalid JSON: {e}")
            return
        try:
            config = load_config()
            _deep_merge(config, updates)
            CONFIG_FILE.write_text(
                json.dumps(config, indent=2, ensure_ascii=False) + "\n")
            self._json_response({"status": "ok", "config": config})
        except Exception as e:
            self._error(500, f"Failed to write config: {e}")

    # ---------- POST /api/fetch-more & /api/fresh-update ----------

    def _handle_scrape(self, resume: bool):
        venv_python = ROOT / ".venv" / "bin" / "python"
        python = str(venv_python) if venv_python.exists() else sys.executable
        cmd = [python, str(SCRAPER)]
        if resume:
            cmd.append("--continue")
        try:
            result = subprocess.run(cmd, cwd=str(ROOT), capture_output=True,
                                    text=True, timeout=300)
            self._json_response({
                "status": "ok" if result.returncode == 0 else "error",
                "output": result.stdout[-2000:] if result.stdout else "",
                "errors": result.stderr[-1000:] if result.stderr else "",
            })
        except subprocess.TimeoutExpired:
            self._error(504, "Scraper timed out after 5 minutes")

    def _handle_scrape_source(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except (ValueError, json.JSONDecodeError):
            body = {}

        sources = body.get("sources", [])
        resume = body.get("resume", False)

        venv_python = ROOT / ".venv" / "bin" / "python"
        python = str(venv_python) if venv_python.exists() else sys.executable
        cmd = [python, str(SCRAPER)]

        for s in sources:
            if s in ("linkedin", "hiringcafe"):
                cmd.extend(["--source", s])

        if resume:
            cmd.append("--continue")

        try:
            result = subprocess.run(cmd, cwd=str(ROOT), capture_output=True,
                                    text=True, timeout=300)
            self._json_response({
                "status": "ok" if result.returncode == 0 else "error",
                "output": result.stdout[-2000:] if result.stdout else "",
                "errors": result.stderr[-1000:] if result.stderr else "",
            })
        except subprocess.TimeoutExpired:
            self._error(504, "Scraper timed out after 5 minutes")


if __name__ == "__main__":
    with http.server.HTTPServer(("", PORT), Handler) as srv:
        print(f"Serving on http://localhost:{PORT}")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
