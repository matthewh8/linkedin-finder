/* Job board frontend: loads config.json + data/jobs.json, renders LinkedIn-style
   list + detail panes with location chips, keyword search, salary highlights,
   source badges, applied tracking and company blocking (both in localStorage). */

(function () {
  "use strict";

  var state = {
    jobs: [],
    lastUpdated: null,
    selectedLocation: "",     // "" = all; single location label
    excludedKeywords: [],    // title substrings to hide
    presets: {},             // name -> {locations, keywords}
    query: "",
    selectedUrl: null,
    locationFilters: [],     // [{label, matchers}] from config.json
    hideApplied: false,
    applied: {},             // job_url -> ISO timestamp
    blocked: [],             // company names
    page: 1,
    perPage: 50,
    totalJobs: 0,
    totalSeen: 0,
    hasMore: false,
    loading: false,
    fetching: false,
  };

  var SOURCES = {
    linkedin: { label: "LinkedIn", badge: "in", cls: "source-linkedin", applyLabel: "Apply on LinkedIn" },
    hiringcafe: { label: "Hiring.Cafe", badge: "☕", cls: "source-hiringcafe", applyLabel: "Apply on company site" },
  };

  var FALLBACK_COLORS = ["#0a66c2", "#01754f", "#915907", "#7a3ba3", "#b24020"];

  var els = {
    layout: document.getElementById("layout"),
    list: document.getElementById("job-list"),
    listHeader: document.getElementById("job-list-header"),
    emptyState: document.getElementById("empty-state"),
    resultCount: document.getElementById("result-count"),
    lastUpdated: document.getElementById("last-updated"),
    searchInput: document.getElementById("search-input"),
    locationSelect: document.getElementById("location-select"),
    appliedToggle: document.getElementById("applied-toggle"),
    blockedBtn: document.getElementById("blocked-btn"),
    blockedPanel: document.getElementById("blocked-panel"),
    blockedList: document.getElementById("blocked-list"),
    blockedEmpty: document.getElementById("blocked-empty"),
    placeholder: document.getElementById("detail-placeholder"),
    card: document.getElementById("detail-card"),
    logo: document.getElementById("detail-logo"),
    logoFallback: document.getElementById("detail-logo-fallback"),
    sourceTag: document.getElementById("detail-source"),
    title: document.getElementById("detail-title"),
    company: document.getElementById("detail-company"),
    location: document.getElementById("detail-location"),
    time: document.getElementById("detail-time"),
    salary: document.getElementById("detail-salary"),
    apply: document.getElementById("apply-btn"),
    applyLabel: document.getElementById("apply-btn-label"),
    appliedBtn: document.getElementById("applied-btn"),
    blockBtn: document.getElementById("block-btn"),
    description: document.getElementById("detail-description"),
    experience: document.getElementById("detail-experience"),
    backBtn: document.getElementById("back-btn"),
    settingsBtn: document.getElementById("settings-btn"),
    settingsOverlay: document.getElementById("settings-overlay"),
    settingsPanel: document.getElementById("settings-panel"),
    settingsClose: document.getElementById("settings-close"),
    filtersBtn: document.getElementById("filters-btn"),
    filtersPanel: document.getElementById("filters-panel"),
    filtersClose: document.getElementById("filters-close"),
    keywordInput: document.getElementById("keyword-input"),
    keywordAdd: document.getElementById("keyword-add"),
    keywordTags: document.getElementById("keyword-tags"),
    presetName: document.getElementById("preset-name"),
    presetSave: document.getElementById("preset-save"),
    presetList: document.getElementById("preset-list"),
    scrapeBtn: document.getElementById("scrape-btn"),
    scrapeOverlay: document.getElementById("scrape-overlay"),
    scrapeClose: document.getElementById("scrape-close"),
    loadMoreRow: document.getElementById("load-more-row"),
    loadMoreBtn: document.getElementById("load-more-btn"),
  };

  // ---------- Persistence (localStorage) ----------

  function loadStored(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveStored(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* private mode etc. — features degrade gracefully */ }
  }

  state.applied = loadStored("nj_applied", {});
  state.blocked = loadStored("nj_blocked", []);
  state.hideApplied = loadStored("nj_hide_applied", false) === true;
  state.selectedLocation = loadStored("nj_location", "");
  state.excludedKeywords = loadStored("nj_excluded_keywords", []);
  state.presets = loadStored("nj_presets", {});

  function isApplied(url) {
    return Object.prototype.hasOwnProperty.call(state.applied, url);
  }

  function isBlocked(company) {
    var c = (company || "").trim().toLowerCase();
    return state.blocked.some(function (b) {
      return b.trim().toLowerCase() === c;
    });
  }

  // ---------- Utilities ----------

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sourceInfo(job) {
    return SOURCES[job.source] || SOURCES.linkedin;
  }

  function jobTimestamp(job) {
    if (job.date_posted) return new Date(job.date_posted + "T00:00:00Z");
    return job.scraped_at ? new Date(job.scraped_at) : null;
  }

  function relativeTime(date) {
    if (!date || isNaN(date)) return "";
    var secs = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (secs < 60) return "Just now";
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function isRecent(date) {
    return date && !isNaN(date) && Date.now() - date.getTime() < 24 * 3600 * 1000;
  }

  function fallbackColor(name) {
    var h = 0;
    for (var i = 0; i < (name || "").length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }

  // Minimal markdown renderer for job descriptions. Input is escaped first,
  // so the produced HTML only contains our tags.
  function renderMarkdown(md) {
    if (!md) return "<p>No description available.</p>";
    // jobspy backslash-escapes markdown punctuation (e.g. "self\-driving").
    var text = md.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1");
    text = escapeHtml(text).replace(/\r\n/g, "\n");

    // Links: [label](url) — http(s) only.
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // Bold and italic.
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    var lines = text.split("\n");
    var html = [];
    var inList = false;
    var para = [];

    function flushPara() {
      if (para.length) {
        html.push("<p>" + para.join("<br>") + "</p>");
        para = [];
      }
    }
    function closeList() {
      if (inList) { html.push("</ul>"); inList = false; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      var bullet = line.match(/^[-*+]\s+(.*)$/);
      if (!line) {
        flushPara(); closeList();
      } else if (heading) {
        flushPara(); closeList();
        html.push("<h3>" + heading[2] + "</h3>");
      } else if (bullet) {
        flushPara();
        if (!inList) { html.push("<ul>"); inList = true; }
        html.push("<li>" + bullet[1] + "</li>");
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara(); closeList();
    return html.join("");
  }

  var _YOE_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*[-–—]|\bto\b\s*\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b/gi;
  var _EXP_CONTEXT_RE = /\b(?:experience|exp\.|developing|building|working|designing|engineering|managing|leading|programming|coding|creating|implementing|maintaining|in\s+\w+|of\s+\w+|with\s+\w+)\b/i;

  function extractExperienceLines(description) {
    if (!description) return [];
    var lines = description.split(/\n/);
    var results = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      _YOE_RE.lastIndex = 0;
      if (_YOE_RE.test(line)) {
        var lower = line.toLowerCase();
        if (_EXP_CONTEXT_RE.test(lower) && !seen[lower]) {
          seen[lower] = true;
          results.push(line);
        }
      }
    }
    return results;
  }

  // ---------- Filtering ----------

  function matchesLocation(job) {
    if (!state.selectedLocation) return true;
    var filter = state.locationFilters.find(function (f) {
      return f.label === state.selectedLocation;
    });
    if (!filter) return true;
    var loc = (job.location || "").toLowerCase();
    return filter.matchers.some(function (m) { return loc.indexOf(m) !== -1; });
  }

  function visibleJobs() {
    return state.jobs.filter(function (job) {
      if (isBlocked(job.company)) return false;
      if (state.hideApplied && isApplied(job.job_url)) return false;
      if (!matchesLocation(job)) return false;
      if (state.excludedKeywords.length > 0) {
        var titleLower = (job.title || "").toLowerCase();
        var excluded = state.excludedKeywords.some(function (kw) {
          return titleLower.indexOf(kw) !== -1;
        });
        if (excluded) return false;
      }
      return true;
    });
  }

  // ---------- API ----------

  function buildJobsUrl(page) {
    var params = "page=" + page + "&per_page=" + state.perPage;
    if (state.query) {
      params += "&q=" + encodeURIComponent(state.query);
    }
    return "/api/jobs?" + params;
  }

  function fetchJobs(page, append) {
    state.loading = true;
    renderLoadMore();
    return fetch(buildJobsUrl(page))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (append) {
          state.jobs = state.jobs.concat(data.jobs || []);
        } else {
          state.jobs = data.jobs || [];
        }
        state.page = data.page;
        state.totalJobs = data.total;
        state.hasMore = data.has_more;
        state.lastUpdated = data.last_updated ? new Date(data.last_updated) : null;
        if (state.lastUpdated && !isNaN(state.lastUpdated)) {
          els.lastUpdated.textContent = "Updated " + relativeTime(state.lastUpdated);
        }
        state.loading = false;
        renderList();
        renderLoadMore();
      })
      .catch(function (err) {
        state.loading = false;
        renderLoadMore();
        els.listHeader.textContent = "Error loading jobs: " + err.message;
      });
  }

  function loadMore() {
    if (state.loading || !state.hasMore) return;
    fetchJobs(state.page + 1, true);
  }

  function setScrapeDisabled(disabled) {
    var btns = document.querySelectorAll(".scrape-action");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = disabled;
  }

  function triggerSourceScrape(sources, resume, logEl) {
    state.fetching = true;
    setScrapeDisabled(true);
    if (logEl) {
      logEl.textContent = "Fetching...";
      logEl.className = "scrape-log";
      logEl.hidden = false;
    }
    return fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: sources, resume: resume }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        state.fetching = false;
        setScrapeDisabled(false);
        if (logEl) {
          var text = (data.output || "").trim();
          if (data.errors) text += (text ? "\n" : "") + data.errors.trim();
          logEl.textContent = text || (data.status === "ok" ? "Done" : "Error");
          logEl.className = "scrape-log" +
            (data.status === "ok" ? " scrape-log-ok" : " scrape-log-error");
        }
        if (data.status === "ok") {
          state.page = 1;
          fetchJobs(1, false);
        }
      })
      .catch(function (err) {
        state.fetching = false;
        setScrapeDisabled(false);
        if (logEl) {
          logEl.textContent = "Failed: " + err.message;
          logEl.className = "scrape-log scrape-log-error";
        }
      });
  }

  function renderLoadMore() {
    if (state.loading) {
      els.loadMoreRow.hidden = false;
      els.loadMoreBtn.textContent = "Loading...";
      els.loadMoreBtn.disabled = true;
    } else if (state.hasMore) {
      els.loadMoreRow.hidden = false;
      var remaining = state.totalJobs - state.jobs.length;
      els.loadMoreBtn.textContent = "Show more jobs (" + remaining + " remaining)";
      els.loadMoreBtn.disabled = false;
    } else {
      els.loadMoreRow.hidden = true;
    }
  }


  // ---------- Rendering ----------

  function logoHtml(job) {
    var src = sourceInfo(job);
    var initial = (job.company || "?").charAt(0).toUpperCase();
    var fallback = '<div class="job-logo-fallback" style="background:' +
      fallbackColor(job.company) + '">' + escapeHtml(initial) + "</div>";
    var img = fallback;
    if (job.company_logo) {
      img = '<img class="job-logo" src="' + escapeHtml(job.company_logo) +
        '" alt="" loading="lazy" onerror="this.outerHTML=' +
        escapeHtml(JSON.stringify(fallback)) + '">';
    }
    return '<div class="logo-wrap">' + img +
      '<span class="source-badge ' + src.cls + '" title="Source: ' +
      escapeHtml(src.label) + '">' + src.badge + "</span></div>";
  }

  function renderLocationSelect() {
    var html = '<option value="">All locations</option>';
    state.locationFilters.forEach(function (f) {
      var selected = state.selectedLocation === f.label ? " selected" : "";
      html += '<option value="' + escapeHtml(f.label) + '"' + selected + '>' +
        escapeHtml(f.label) + "</option>";
    });
    els.locationSelect.innerHTML = html;
  }

  function renderControls() {
    els.appliedToggle.textContent = state.hideApplied ? "Show all" : "Hide applied";
    els.appliedToggle.classList.toggle("chip-active", state.hideApplied);
    var n = state.blocked.length;
    els.blockedBtn.textContent = "Blocked" + (n ? " (" + n + ")" : "");
    var kn = state.excludedKeywords.length;
    els.filtersBtn.textContent = "Filters" + (kn ? " (" + kn + ")" : "");
    els.filtersBtn.classList.toggle("chip-active", kn > 0);
  }

  function renderBlockedPanel() {
    els.blockedEmpty.hidden = state.blocked.length > 0;
    els.blockedList.innerHTML = state.blocked.map(function (name) {
      return '<li class="blocked-item">' + escapeHtml(name) +
        '<button class="unblock-btn" data-company="' + escapeHtml(name) +
        '" aria-label="Unblock ' + escapeHtml(name) + '">Unblock</button></li>';
    }).join("");
  }

  function renderList() {
    var jobs = visibleJobs();
    els.list.innerHTML = jobs.map(function (job) {
      var ts = jobTimestamp(job);
      var applied = isApplied(job.job_url);
      var classes = "job-card" +
        (job.job_url === state.selectedUrl ? " job-card-active" : "") +
        (applied ? " job-applied" : "");
      var timeClass = isRecent(ts) ? "" : " job-time-old";
      return '<li class="' + classes + '" data-url="' +
        escapeHtml(job.job_url) + '" tabindex="0" role="button">' +
        logoHtml(job) +
        '<div class="job-card-body">' +
        '<div class="job-title">' + escapeHtml(job.title || "Untitled role") + "</div>" +
        '<div class="job-company">' + escapeHtml(job.company || "") + "</div>" +
        '<div class="job-location">' + escapeHtml(job.location || "") + "</div>" +
        (job.salary
          ? '<div class="job-salary">' + escapeHtml(job.salary) + "</div>"
          : "") +
        '<div class="job-time' + timeClass + '">' + relativeTime(ts) +
        (applied ? '<span class="applied-tag">Applied</span>' : "") +
        "</div></div></li>";
    }).join("");

    els.emptyState.hidden = jobs.length > 0;
    var showing = jobs.length;
    var total = state.totalJobs;
    els.resultCount.textContent = showing + " of " + total +
      (total === 1 ? " job" : " jobs");
    els.listHeader.textContent = "New grad software engineer roles · " +
      showing + " of " + total + " result" + (total === 1 ? "" : "s");

    // Keep a valid selection on desktop so the detail pane isn't stale.
    var selectedVisible = jobs.some(function (j) { return j.job_url === state.selectedUrl; });
    var isMobile = window.matchMedia("(max-width: 767px)").matches;
    if (!selectedVisible) {
      if (jobs.length && !isMobile) {
        selectJob(jobs[0].job_url, false);
      } else {
        state.selectedUrl = null;
        els.card.hidden = true;
        els.placeholder.style.display = "";
        els.layout.classList.remove("show-detail");
      }
    }
  }

  function renderAppliedBtn(job) {
    var applied = isApplied(job.job_url);
    els.appliedBtn.textContent = applied ? "✓ Applied — undo" : "Mark as applied";
    els.appliedBtn.classList.toggle("pill-btn-done", applied);
  }

  function selectJob(url, userInitiated) {
    var job = state.jobs.find(function (j) { return j.job_url === url; });
    if (!job) return;
    state.selectedUrl = url;

    els.placeholder.style.display = "none";
    els.card.hidden = false;

    els.logo.hidden = true;
    els.logoFallback.hidden = true;
    if (job.company_logo) {
      els.logo.src = job.company_logo;
      els.logo.hidden = false;
      els.logo.onerror = function () {
        els.logo.hidden = true;
        showLogoFallback(job);
      };
    } else {
      showLogoFallback(job);
    }

    var src = sourceInfo(job);
    els.sourceTag.textContent = "via " + src.label;
    els.sourceTag.className = "source-tag " + src.cls;

    els.title.textContent = job.title || "Untitled role";
    els.company.textContent = job.company || "";
    els.location.textContent = job.location || "";
    els.time.textContent = relativeTime(jobTimestamp(job));
    els.salary.hidden = !job.salary;
    els.salary.textContent = job.salary || "";
    els.apply.href = job.job_url;
    els.applyLabel.textContent = src.applyLabel;
    renderAppliedBtn(job);
    els.blockBtn.textContent = "Block " + (job.company || "company");
    els.description.innerHTML = renderMarkdown(job.description);

    var expLines = extractExperienceLines(job.description || "");
    var hasStructured = job.min_experience_years != null;
    if (expLines.length || hasStructured) {
      var expHtml = "";
      if (hasStructured) {
        var y = job.min_experience_years;
        expHtml += '<span class="exp-badge">' + escapeHtml(String(y)) +
                   (y === 1 ? " year" : " years") + " min experience</span>";
      }
      if (expLines.length) {
        expHtml += "<ul>";
        for (var ei = 0; ei < expLines.length; ei++) {
          expHtml += "<li>" + escapeHtml(expLines[ei]) + "</li>";
        }
        expHtml += "</ul>";
      }
      els.experience.innerHTML = expHtml;
      els.experience.hidden = false;
    } else {
      els.experience.innerHTML = "";
      els.experience.hidden = true;
    }

    document.querySelectorAll(".job-card").forEach(function (card) {
      card.classList.toggle("job-card-active", card.dataset.url === url);
    });

    if (userInitiated) {
      els.layout.classList.add("show-detail");
      els.card.parentElement.scrollTop = 0;
      if (window.matchMedia("(max-width: 767px)").matches) {
        window.scrollTo(0, 0);
      }
    }
  }

  function showLogoFallback(job) {
    els.logoFallback.textContent = (job.company || "?").charAt(0).toUpperCase();
    els.logoFallback.style.background = fallbackColor(job.company);
    els.logoFallback.hidden = false;
  }

  // ---------- Events ----------

  els.list.addEventListener("click", function (e) {
    var card = e.target.closest(".job-card");
    if (card) selectJob(card.dataset.url, true);
  });

  els.list.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      var card = e.target.closest(".job-card");
      if (card) { e.preventDefault(); selectJob(card.dataset.url, true); }
    }
  });

  els.backBtn.addEventListener("click", function () {
    els.layout.classList.remove("show-detail");
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    var tag = (document.activeElement || {}).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var jobs = visibleJobs();
    if (!jobs.length) return;
    var idx = -1;
    if (state.selectedUrl) {
      for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].job_url === state.selectedUrl) { idx = i; break; }
      }
    }
    var next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    if (next < 0 || next >= jobs.length) return;
    e.preventDefault();
    selectJob(jobs[next].job_url, true);
    var cards = els.list.querySelectorAll(".job-card");
    if (cards[next]) cards[next].scrollIntoView({ block: "nearest" });
  });

  els.locationSelect.addEventListener("change", function () {
    state.selectedLocation = els.locationSelect.value;
    saveStored("nj_location", state.selectedLocation);
    renderList();
  });

  var searchTimer = null;
  els.searchInput.addEventListener("input", function () {
    state.query = els.searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.page = 1;
      fetchJobs(1, false);
    }, 300);
  });

  els.appliedToggle.addEventListener("click", function () {
    state.hideApplied = !state.hideApplied;
    saveStored("nj_hide_applied", state.hideApplied);
    renderControls();
    renderList();
  });

  els.appliedBtn.addEventListener("click", function () {
    var url = state.selectedUrl;
    if (!url) return;
    if (isApplied(url)) {
      delete state.applied[url];
    } else {
      state.applied[url] = new Date().toISOString();
    }
    saveStored("nj_applied", state.applied);
    var job = state.jobs.find(function (j) { return j.job_url === url; });
    if (job) renderAppliedBtn(job);
    renderList();
  });

  els.blockBtn.addEventListener("click", function () {
    var job = state.jobs.find(function (j) { return j.job_url === state.selectedUrl; });
    if (!job || !job.company || isBlocked(job.company)) return;
    state.blocked.push(job.company);
    saveStored("nj_blocked", state.blocked);
    renderControls();
    renderBlockedPanel();
    renderList();
  });

  els.blockedBtn.addEventListener("click", function () {
    els.blockedPanel.hidden = !els.blockedPanel.hidden;
    els.filtersPanel.hidden = true;
    if (!els.blockedPanel.hidden) renderBlockedPanel();
  });

  els.blockedPanel.addEventListener("click", function (e) {
    var btn = e.target.closest(".unblock-btn");
    if (!btn) return;
    state.blocked = state.blocked.filter(function (b) { return b !== btn.dataset.company; });
    saveStored("nj_blocked", state.blocked);
    renderControls();
    renderBlockedPanel();
    renderList();
  });

  document.addEventListener("click", function (e) {
    if (!els.blockedPanel.hidden &&
        !els.blockedPanel.contains(e.target) && e.target !== els.blockedBtn) {
      els.blockedPanel.hidden = true;
    }
    if (!els.filtersPanel.hidden &&
        !els.filtersPanel.contains(e.target) && e.target !== els.filtersBtn) {
      els.filtersPanel.hidden = true;
    }
  });

  // ---------- Scrape & pagination buttons ----------

  els.loadMoreBtn.addEventListener("click", loadMore);

  // ---------- Scrape panel ----------

  function openScrape() { els.scrapeOverlay.hidden = false; }
  function closeScrape() { els.scrapeOverlay.hidden = true; }

  els.scrapeBtn.addEventListener("click", openScrape);
  els.scrapeClose.addEventListener("click", function (e) {
    e.stopPropagation();
    closeScrape();
  });

  els.scrapeOverlay.addEventListener("click", function (e) {
    if (e.target === els.scrapeOverlay) { closeScrape(); return; }
    var btn = e.target.closest(".scrape-action");
    if (!btn || btn.disabled || state.fetching) return;
    var srcStr = btn.dataset.sources || "";
    var sources = srcStr.split(",").filter(Boolean);
    var resume = btn.dataset.resume === "true";
    var logId = sources.length === 1 ? "scrape-log-" + sources[0] : "scrape-log-all";
    triggerSourceScrape(sources, resume, document.getElementById(logId));
  });

  // ---------- Filters panel ----------

  function renderKeywords() {
    if (!state.excludedKeywords.length) {
      els.keywordTags.innerHTML = '<span class="filters-empty">No excluded keywords</span>';
      return;
    }
    els.keywordTags.innerHTML = state.excludedKeywords.map(function (kw) {
      return '<span class="keyword-tag">' + escapeHtml(kw) +
        '<button class="keyword-remove" data-keyword="' + escapeHtml(kw) +
        '" aria-label="Remove ' + escapeHtml(kw) + '">&times;</button></span>';
    }).join("");
  }

  function renderPresets() {
    var names = Object.keys(state.presets);
    if (!names.length) {
      els.presetList.innerHTML = '<span class="filters-empty">No saved presets</span>';
      return;
    }
    els.presetList.innerHTML = names.map(function (name) {
      var p = state.presets[name];
      var desc = [];
      if (p.locations.length) desc.push(p.locations.join(", "));
      if (p.keywords.length) desc.push("exclude: " + p.keywords.join(", "));
      return '<div class="preset-item">' +
        '<button class="preset-load" data-preset="' + escapeHtml(name) + '">' +
        '<span class="preset-name">' + escapeHtml(name) + '</span>' +
        '<span class="preset-desc">' + escapeHtml(desc.join(" · ") || "All locations, no exclusions") + '</span>' +
        '</button>' +
        '<button class="preset-delete" data-preset="' + escapeHtml(name) +
        '" aria-label="Delete preset ' + escapeHtml(name) + '">&times;</button></div>';
    }).join("");
  }

  els.filtersBtn.addEventListener("click", function () {
    els.filtersPanel.hidden = !els.filtersPanel.hidden;
    els.blockedPanel.hidden = true;
    if (!els.filtersPanel.hidden) {
      renderKeywords();
      renderPresets();
    }
  });

  els.filtersClose.addEventListener("click", function () {
    els.filtersPanel.hidden = true;
  });

  function addKeyword() {
    var raw = els.keywordInput.value.trim().toLowerCase();
    if (!raw) return;
    var parts = raw.split(",");
    parts.forEach(function (part) {
      var kw = part.trim();
      if (kw && state.excludedKeywords.indexOf(kw) === -1) {
        state.excludedKeywords.push(kw);
      }
    });
    saveStored("nj_excluded_keywords", state.excludedKeywords);
    els.keywordInput.value = "";
    renderKeywords();
    renderControls();
    renderList();
  }

  els.keywordAdd.addEventListener("click", addKeyword);
  els.keywordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addKeyword();
  });

  els.keywordTags.addEventListener("click", function (e) {
    var btn = e.target.closest(".keyword-remove");
    if (!btn) return;
    state.excludedKeywords = state.excludedKeywords.filter(function (kw) {
      return kw !== btn.dataset.keyword;
    });
    saveStored("nj_excluded_keywords", state.excludedKeywords);
    renderKeywords();
    renderControls();
    renderList();
  });

  els.presetSave.addEventListener("click", function () {
    var name = els.presetName.value.trim();
    if (!name) return;
    state.presets[name] = {
      location: state.selectedLocation,
      keywords: state.excludedKeywords.slice(),
    };
    saveStored("nj_presets", state.presets);
    els.presetName.value = "";
    renderPresets();
  });

  els.presetName.addEventListener("keydown", function (e) {
    if (e.key === "Enter") els.presetSave.click();
  });

  els.presetList.addEventListener("click", function (e) {
    var deleteBtn = e.target.closest(".preset-delete");
    if (deleteBtn) {
      delete state.presets[deleteBtn.dataset.preset];
      saveStored("nj_presets", state.presets);
      renderPresets();
      return;
    }
    var loadBtn = e.target.closest(".preset-load");
    if (loadBtn) {
      var p = state.presets[loadBtn.dataset.preset];
      if (!p) return;
      state.selectedLocation = p.location || "";
      state.excludedKeywords = p.keywords.slice();
      saveStored("nj_location", state.selectedLocation);
      saveStored("nj_excluded_keywords", state.excludedKeywords);
      renderLocationSelect();
      renderKeywords();
      renderControls();
      renderList();
    }
  });

  // ---------- Settings panel ----------

  var settingsTimer = null;

  function openSettings() {
    fetch("/api/config")
      .then(function (r) { return r.json(); })
      .then(function (cfg) { populateSettings(cfg); })
      .catch(function (err) { console.error("Failed to load config", err); });
    els.settingsOverlay.hidden = false;
  }

  function closeSettings() {
    els.settingsOverlay.hidden = true;
  }

  function populateSettings(cfg) {
    var li = cfg.linkedin || {};

    document.getElementById("cfg-max-experience").value = cfg.max_experience_years || 0;
    document.getElementById("cfg-window-days").value = cfg.window_days || 7;

    document.getElementById("cfg-li-enabled").checked = li.enabled !== false;
    renderSettingsTags("cfg-li-search-terms", li.search_terms || [], "li-terms");
    renderSettingsTags("cfg-li-locations", li.locations || [], "li-locs");
    document.getElementById("cfg-li-hours-old").value = li.hours_old || 24;
    document.getElementById("cfg-li-batch-size").value = li.batch_size || 15;
  }

  function setCheckboxGroup(containerId, values) {
    var inputs = document.getElementById(containerId).querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = values.indexOf(inputs[i].value) !== -1;
    }
  }

  function getCheckboxGroup(containerId) {
    var checked = document.getElementById(containerId).querySelectorAll('input[type="checkbox"]:checked');
    var values = [];
    for (var i = 0; i < checked.length; i++) values.push(checked[i].value);
    return values;
  }

  function renderSettingsTags(containerId, items, dataKey) {
    var container = document.getElementById(containerId);
    container.innerHTML = items.map(function (item) {
      return '<span class="keyword-tag">' + escapeHtml(item) +
        '<button class="keyword-remove" data-key="' + dataKey +
        '" data-value="' + escapeHtml(item) + '">&times;</button></span>';
    }).join("");
    container.dataset.items = JSON.stringify(items);
  }

  function getSettingsTagItems(containerId) {
    var container = document.getElementById(containerId);
    try { return JSON.parse(container.dataset.items || "[]"); }
    catch (e) { return []; }
  }

  function collectConfig() {
    return {
      max_experience_years: parseInt(document.getElementById("cfg-max-experience").value, 10) || 0,
      window_days: parseInt(document.getElementById("cfg-window-days").value, 10) || 7,
      linkedin: {
        enabled: document.getElementById("cfg-li-enabled").checked,
        search_terms: getSettingsTagItems("cfg-li-search-terms"),
        locations: getSettingsTagItems("cfg-li-locations"),
        hours_old: parseInt(document.getElementById("cfg-li-hours-old").value, 10) || 24,
        batch_size: parseInt(document.getElementById("cfg-li-batch-size").value, 10) || 15,
      },
    };
  }

  function saveConfig() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () {
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectConfig()),
      }).catch(function (err) {
        console.error("Failed to save config", err);
      });
    }, 600);
  }

  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSettings();
  });
  els.settingsOverlay.addEventListener("click", function (e) {
    if (e.target === els.settingsOverlay) closeSettings();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!els.scrapeOverlay.hidden) { closeScrape(); return; }
      if (!els.settingsOverlay.hidden) closeSettings();
    }
  });

  els.settingsPanel.addEventListener("input", saveConfig);
  els.settingsPanel.addEventListener("change", saveConfig);

  document.getElementById("cfg-li-term-add").addEventListener("click", function () {
    var input = document.getElementById("cfg-li-term-input");
    var val = input.value.trim();
    if (!val) return;
    var items = getSettingsTagItems("cfg-li-search-terms");
    if (items.indexOf(val) === -1) items.push(val);
    renderSettingsTags("cfg-li-search-terms", items, "li-terms");
    input.value = "";
    saveConfig();
  });

  document.getElementById("cfg-li-term-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("cfg-li-term-add").click();
  });

  document.getElementById("cfg-li-loc-add").addEventListener("click", function () {
    var input = document.getElementById("cfg-li-loc-input");
    var val = input.value.trim();
    if (!val) return;
    var items = getSettingsTagItems("cfg-li-locations");
    if (items.indexOf(val) === -1) items.push(val);
    renderSettingsTags("cfg-li-locations", items, "li-locs");
    input.value = "";
    saveConfig();
  });

  document.getElementById("cfg-li-loc-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("cfg-li-loc-add").click();
  });

  els.settingsPanel.addEventListener("click", function (e) {
    var btn = e.target.closest(".keyword-remove");
    if (!btn || !btn.dataset.key) return;
    var key = btn.dataset.key;
    var containerId = key === "li-terms" ? "cfg-li-search-terms" : "cfg-li-locations";
    var items = getSettingsTagItems(containerId).filter(function (item) {
      return item !== btn.dataset.value;
    });
    renderSettingsTags(containerId, items, key);
    saveConfig();
  });

  // ---------- Init ----------

  fetch("config.json?t=" + Date.now())
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (config) {
      state.locationFilters = config.location_filters || [];
      renderLocationSelect();
      renderControls();
      renderBlockedPanel();
      return fetchJobs(1, false);
    })
    .catch(function (err) {
      els.listHeader.textContent = "Could not load job data (" + err.message + ")";
    });
})();
