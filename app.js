/* Job board frontend: loads config.json + data/jobs.json, renders LinkedIn-style
   list + detail panes with location chips, keyword search, salary highlights,
   source badges, applied tracking and company blocking (both in localStorage). */

(function () {
  "use strict";

  var state = {
    jobs: [],
    lastUpdated: null,
    selectedLocations: [],   // [] = all; subset of location labels
    excludedKeywords: [],    // title substrings to hide
    presets: {},             // name -> {locations, keywords}
    query: "",
    selectedUrl: null,
    locationFilters: [],     // [{label, matchers}] from config.json
    hideApplied: false,
    applied: {},             // job_url -> ISO timestamp
    blocked: [],             // company names
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
    chips: document.getElementById("filter-chips"),
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
    backBtn: document.getElementById("back-btn"),
    filtersBtn: document.getElementById("filters-btn"),
    filtersPanel: document.getElementById("filters-panel"),
    filtersClose: document.getElementById("filters-close"),
    keywordInput: document.getElementById("keyword-input"),
    keywordAdd: document.getElementById("keyword-add"),
    keywordTags: document.getElementById("keyword-tags"),
    presetName: document.getElementById("preset-name"),
    presetSave: document.getElementById("preset-save"),
    presetList: document.getElementById("preset-list"),
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
  state.selectedLocations = loadStored("nj_locations", []);
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
    // date_posted is date-only; scraped_at is a full ISO timestamp. Prefer
    // scraped_at when both fall on the same day so "N minutes ago" works.
    var scraped = job.scraped_at ? new Date(job.scraped_at) : null;
    var posted = job.date_posted ? new Date(job.date_posted + "T00:00:00Z") : null;
    if (posted && scraped && posted.toDateString() !== scraped.toDateString()) {
      return posted;
    }
    return scraped || posted;
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

  // ---------- Filtering ----------

  function matchersFor(filterLabel) {
    for (var i = 0; i < state.locationFilters.length; i++) {
      if (state.locationFilters[i].label === filterLabel) {
        return state.locationFilters[i].matchers || [];
      }
    }
    return null;
  }

  function visibleJobs() {
    var needles = null;
    if (state.selectedLocations.length > 0) {
      needles = [];
      state.selectedLocations.forEach(function (label) {
        var m = matchersFor(label);
        if (m) needles = needles.concat(m);
      });
    }
    var q = state.query.trim().toLowerCase();
    return state.jobs.filter(function (job) {
      if (isBlocked(job.company)) return false;
      if (state.hideApplied && isApplied(job.job_url)) return false;
      if (needles) {
        var loc = (job.location || "").toLowerCase();
        var hit = needles.some(function (n) { return loc.indexOf(n) !== -1; });
        if (!hit) return false;
      }
      if (state.excludedKeywords.length > 0) {
        var titleLower = (job.title || "").toLowerCase();
        var excluded = state.excludedKeywords.some(function (kw) {
          return titleLower.indexOf(kw) !== -1;
        });
        if (excluded) return false;
      }
      if (q) {
        var hay = ((job.title || "") + " " + (job.company || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
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

  function renderChips() {
    var html = '<button class="chip' +
      (state.selectedLocations.length === 0 ? " chip-active" : "") +
      '" data-filter="all">All</button>';
    state.locationFilters.forEach(function (f) {
      var active = state.selectedLocations.indexOf(f.label) !== -1;
      html += '<button class="chip' +
        (active ? " chip-active" : "") +
        '" data-filter="' + escapeHtml(f.label) + '">' +
        escapeHtml(f.label) + "</button>";
    });
    els.chips.innerHTML = html;
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
    els.resultCount.textContent = jobs.length + (jobs.length === 1 ? " job" : " jobs");
    els.listHeader.textContent = "New grad software engineer roles · " +
      jobs.length + " result" + (jobs.length === 1 ? "" : "s");

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

  els.chips.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (!chip) return;
    var filter = chip.dataset.filter;
    if (filter === "all") {
      state.selectedLocations = [];
    } else {
      var idx = state.selectedLocations.indexOf(filter);
      if (idx !== -1) {
        state.selectedLocations.splice(idx, 1);
      } else {
        state.selectedLocations.push(filter);
      }
    }
    saveStored("nj_locations", state.selectedLocations);
    renderChips();
    renderList();
  });

  els.searchInput.addEventListener("input", function () {
    state.query = els.searchInput.value;
    renderList();
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
      locations: state.selectedLocations.slice(),
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
      state.selectedLocations = p.locations.slice();
      state.excludedKeywords = p.keywords.slice();
      saveStored("nj_locations", state.selectedLocations);
      saveStored("nj_excluded_keywords", state.excludedKeywords);
      renderChips();
      renderKeywords();
      renderControls();
      renderList();
    }
  });

  // ---------- Init ----------

  Promise.all([
    fetch("data/jobs.json?t=" + Date.now()).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }),
    fetch("config.json?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; }),
  ])
    .then(function (results) {
      var data = results[0];
      var config = results[1];
      state.jobs = data.jobs || [];
      state.locationFilters = config.location_filters || [];
      state.lastUpdated = data.last_updated ? new Date(data.last_updated) : null;
      if (state.lastUpdated && !isNaN(state.lastUpdated)) {
        els.lastUpdated.textContent = "Updated " + relativeTime(state.lastUpdated);
      }
      renderChips();
      renderControls();
      renderBlockedPanel();
      renderList();
    })
    .catch(function (err) {
      els.listHeader.textContent = "Could not load job data (" + err.message + ")";
    });
})();
