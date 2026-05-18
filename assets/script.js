/**
 * CCTools Status — editorial layout client.
 *
 * Single fetch loop, single render path. Browser-side probes for the
 * 3 public surfaces (cctools.network, api.cctools.network, docs.cctools.network)
 * are folded into the same services list so the page has one canonical
 * view of "what's being monitored" instead of multiple card grids.
 *
 * Resilience: requires 2 consecutive fetch failures before surfacing
 * the offline state — avoids the previous "flash unreachable on first
 * paint" bug when fetch took >200ms.
 */

(function () {
  "use strict";

  var API_URL = "https://api.cctools.network/api/v1/public/status";
  var POLL_MS = 30 * 1000;
  var CACHE_KEY = "cctools.status.last";
  var FETCH_TIMEOUT_MS = 8000;
  var OFFLINE_THRESHOLD = 2; // consecutive failures before showing offline

  // The services we surface — one row per logical service. Each maps to
  // either a backend `group` (from /v1/public/status data) OR a browser
  // probe ID. Order is editorial: most-trafficked surface first.
  var SERVICES = [
    { id: "ecosystem", source: "api", group: "ecosystem", title: "Ecosystem", desc: "Projects, trending, categories, rankings" },
    { id: "users", source: "api", group: "users", title: "Users", desc: "Profiles, badges, contributions, activity" },
    { id: "earn", source: "api", group: "earn", title: "Earn", desc: "Opportunities and campaigns" },
    { id: "leaderboard", source: "api", group: "leaderboard", title: "Leaderboard", desc: "XP rankings" },
    { id: "meta", source: "api", group: "meta", title: "API Documentation", desc: "OpenAPI 3.0 specification" },
    { id: "web", source: "probe", title: "Public site", desc: "cctools.network", probeUrl: "https://cctools.network/favicon.ico", probeMethod: "image" },
    { id: "api-root", source: "probe", title: "API gateway", desc: "api.cctools.network reachability", probeUrl: "https://api.cctools.network/api/v1/openapi.json", probeMethod: "fetch" },
    { id: "docs", source: "probe", title: "Documentation site", desc: "docs.cctools.network", probeUrl: "https://docs.cctools.network/favicon.ico", probeMethod: "image" },
  ];

  // ─── DOM refs ────────────────────────────────────────────────────────────
  var $mastheadDate = document.getElementById("masthead-date");
  var $hero = document.getElementById("hero");
  var $heroEyebrow = document.getElementById("hero-eyebrow");
  var $heroEyebrowText = document.getElementById("hero-eyebrow-text");
  var $heroTitle = document.getElementById("hero-title");
  var $heroMeta = document.getElementById("hero-meta");

  var $serviceList = document.getElementById("service-list");
  var $servicesSub = document.getElementById("services-sub");

  var $incSection = document.getElementById("incidents-section");
  var $incList = document.getElementById("incidents-list");

  // ─── State ───────────────────────────────────────────────────────────────
  var lastData = null;
  var lastFromCache = false;
  var lastTimestamp = null;
  var failureCount = 0;
  var probeResults = {}; // id → { ok, latency_ms, last_check }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function relTime(iso) {
    if (!iso) return "—";
    // Clamp at 0 — a server timestamp slightly ahead of the client clock
    // (CDN edge return ~200ms after server set checked_at) would render
    // as "-1 seconds ago" otherwise.
    var d = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (d < 5) return "just now";
    if (d < 60) return Math.floor(d) + " seconds ago";
    if (d < 3600) {
      var m = Math.floor(d / 60);
      return m + (m === 1 ? " minute ago" : " minutes ago");
    }
    if (d < 86400) {
      var h = Math.floor(d / 3600);
      return h + (h === 1 ? " hour ago" : " hours ago");
    }
    var dd = Math.floor(d / 86400);
    return dd + (dd === 1 ? " day ago" : " days ago");
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function fmtDate(d) {
    var months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  // ─── Cache ───────────────────────────────────────────────────────────────
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.data || !parsed.timestamp) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data: data, timestamp: Date.now() }));
    } catch (e) {}
  }

  // ─── Service aggregation ────────────────────────────────────────────────
  function aggregateApiService(group, endpoints) {
    var inGroup = endpoints.filter(function (e) { return e.group === group; });
    if (!inGroup.length) {
      return { status: "unknown", checks: 0, uptime_pct: null, avg_latency: null };
    }
    var sampled = inGroup.filter(function (e) { return e.last_ok !== null; });
    var downCount = sampled.filter(function (e) { return e.last_ok === false; }).length;

    var status;
    if (sampled.length === 0) status = "unknown";
    else if (downCount === 0) status = "operational";
    else if (downCount >= Math.ceil(sampled.length / 2)) status = "major_outage";
    else status = "degraded";

    var uptimeAvg = null;
    var ups = sampled.filter(function (e) { return e.uptime_pct_1h != null; });
    if (ups.length) {
      uptimeAvg = Math.round(
        (ups.reduce(function (a, e) { return a + e.uptime_pct_1h; }, 0) / ups.length) * 10
      ) / 10;
    }

    var latAvg = null;
    var lats = sampled.filter(function (e) { return e.avg_latency_1h != null; });
    if (lats.length) {
      latAvg = Math.round(lats.reduce(function (a, e) { return a + e.avg_latency_1h; }, 0) / lats.length);
    }

    return {
      status: status,
      checks: inGroup.length,
      uptime_pct: uptimeAvg,
      avg_latency: latAvg,
    };
  }

  function aggregateProbe(id) {
    var p = probeResults[id];
    if (!p) return { status: "unknown", checks: 1, uptime_pct: null, avg_latency: null };
    return {
      status: p.ok ? "operational" : "major_outage",
      checks: 1,
      uptime_pct: null,
      avg_latency: p.latency_ms,
    };
  }

  // ─── Overall computation ─────────────────────────────────────────────────
  // Browser-side probes (cctools.network, docs.cctools.network) are
  // intentionally EXCLUDED from this calculation: they reflect the
  // visitor's view, which is wrong when the visitor's IP is rate-limited
  // / WAF-challenged / on a flaky network. A status page driven by one
  // visitor's perspective is worse than no status page. Probes still
  // render as informational rows but never move the overall hero.
  function computeOverall() {
    if (!lastData) return "unknown";

    // Detect the "checker just booted, no ticks yet" state: every API
    // endpoint has last_ok === null. Without this we'd show "operational"
    // based on no evidence, which is misleading.
    var endpoints = lastData.endpoints || [];
    var anySampled = endpoints.some(function (e) { return e.last_ok !== null; });
    if (!anySampled) return "initializing";

    var apiStatuses = SERVICES
      .filter(function (svc) { return svc.source === "api"; })
      .map(function (svc) { return aggregateApiService(svc.group, endpoints).status; });

    var hasMajor = apiStatuses.indexOf("major_outage") !== -1;
    var hasDegraded = apiStatuses.indexOf("degraded") !== -1;

    var backendSays = lastData.overall;
    if (backendSays === "major_outage" || hasMajor) return "major_outage";
    if (backendSays === "degraded" || hasDegraded) return "degraded";
    return "operational";
  }

  // ─── Renderers ──────────────────────────────────────────────────────────
  var STATUS_TITLE = {
    operational: "All systems operational.",
    degraded: "Some surfaces are degraded.",
    major_outage: "We're investigating an outage.",
    initializing: "Bringing checks online.",
    unknown: "Checking status…",
  };

  var STATUS_EYEBROW = {
    operational: "Operational",
    degraded: "Degraded",
    major_outage: "Major outage",
    initializing: "Initializing",
    unknown: "Checking",
  };

  function renderHero() {
    var overall = computeOverall();
    $heroEyebrow.className = "hero-eyebrow s-" + overall;
    $heroEyebrowText.textContent = STATUS_EYEBROW[overall];

    // Slight editorial flourish: italicize the trailing word of the title.
    var title = STATUS_TITLE[overall];
    var match = title.match(/^(.*?)(\s\S+\.?)$/);
    if (match) {
      $heroTitle.innerHTML =
        escapeHtml(match[1]) + "<em>" + escapeHtml(match[2]) + "</em>";
    } else {
      $heroTitle.textContent = title;
    }

    var pieces = [];
    if (lastData && lastData.checked_at) {
      pieces.push("Last server check <strong>" + relTime(lastData.checked_at) + "</strong>");
    } else {
      pieces.push("Connecting to api.cctools.network…");
    }

    if (lastFromCache && lastTimestamp) {
      pieces.push(
        '<span class="offline-inline">' +
        "(cached from " + relTime(new Date(lastTimestamp).toISOString()) + ")" +
        "</span>"
      );
    }

    $heroMeta.innerHTML = pieces.join(" · ");
  }

  function renderServices() {
    if (!lastData) {
      $serviceList.innerHTML =
        '<li class="service-row svc-row-loading"><div class="svc-name">Loading checks…</div></li>';
      $servicesSub.textContent = "—";
      return;
    }

    var endpoints = lastData.endpoints || [];
    var html = SERVICES.map(function (svc) {
      var agg = svc.source === "api"
        ? aggregateApiService(svc.group, endpoints)
        : aggregateProbe(svc.id);

      var status = agg.status;
      var statusWord = {
        operational: "Operational",
        degraded: "Degraded",
        major_outage: "Down",
        unknown: "—",
      }[status];

      var statsBits = [];
      if (svc.source === "api") {
        statsBits.push(agg.checks + " check" + (agg.checks === 1 ? "" : "s"));
        if (agg.uptime_pct != null) statsBits.push(agg.uptime_pct + "% · 1h");
        if (agg.avg_latency != null) statsBits.push(agg.avg_latency + "ms");
      } else {
        if (agg.avg_latency != null) statsBits.push(agg.avg_latency + "ms");
      }

      // Browser-side probes get a small "your view" label so visitors
      // understand a red bullet here means THEIR network can't reach
      // the surface — not that we're down for everyone. Prevents the
      // status page from looking apocalyptic when a single WAF rule
      // bounces one user's IP.
      var viewTag = svc.source === "probe"
        ? '<span class="svc-tag" title="Reachability from your browser, not authoritative">your view</span>'
        : "";

      return (
        '<li class="service-row svc-' + svc.source + '">' +
        '  <span class="svc-bullet s-' + status + '" aria-hidden="true"></span>' +
        '  <div class="svc-info">' +
        '    <div class="svc-name">' + escapeHtml(svc.title) + viewTag + "</div>" +
        '    <div class="svc-desc">' + escapeHtml(svc.desc) + "</div>" +
        "  </div>" +
        '  <div class="svc-stats">' +
        '    <span class="status-word s-' + status + '">' + escapeHtml(statusWord) + "</span>" +
        escapeHtml(statsBits.join(" · ")) +
        "  </div>" +
        "</li>"
      );
    }).join("");

    $serviceList.innerHTML = html;

    var totalChecks = endpoints.length + SERVICES.filter(function (s) { return s.source === "probe"; }).length;
    $servicesSub.textContent =
      SERVICES.length + " services · " + totalChecks + " checks";
  }

  function renderIncidents() {
    if (!lastData) {
      $incSection.hidden = true;
      return;
    }
    var incidents = lastData.incidents || [];
    if (!incidents.length) {
      $incSection.hidden = true;
      return;
    }
    $incSection.hidden = false;

    incidents.sort(function (a, b) {
      return new Date(b.created_at) - new Date(a.created_at);
    });

    var html = incidents.map(function (i) {
      var sev = i.severity === "critical" || i.severity === "major" ? "red"
        : i.severity === "maintenance" ? "amber"
        : i.severity === "minor" ? "amber"
        : "amber";
      var statusTag = i.status === "resolved" ? "green" : "amber";

      var bodyHtml = i.body
        ? '<p class="incident-body">' + escapeHtml(i.body) + "</p>"
        : "";

      var metaPieces = ["Opened " + escapeHtml(relTime(i.created_at))];
      if (i.resolved_at) metaPieces.push("resolved " + escapeHtml(relTime(i.resolved_at)));

      return (
        '<li class="incident-item">' +
        '  <div class="incident-head">' +
        '    <h3 class="incident-title">' + escapeHtml(i.title || "Untitled incident") + "</h3>" +
        '    <span class="tag t-' + sev + '">' + escapeHtml(i.severity) + "</span>" +
        '    <span class="tag t-' + statusTag + '">' + escapeHtml(i.status) + "</span>" +
        "  </div>" +
        bodyHtml +
        '  <div class="incident-meta">' + metaPieces.join(" · ") + "</div>" +
        "</li>"
      );
    }).join("");

    $incList.innerHTML = html;
  }

  function render() {
    renderHero();
    renderServices();
    renderIncidents();
  }

  // ─── Browser probes ──────────────────────────────────────────────────────
  function probeImage(url) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var img = new Image();
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        resolve({ ok: ok, latency_ms: Date.now() - start });
      }
      img.onload = function () { finish(true); };
      img.onerror = function () { finish(false); };
      img.src = url + "?_=" + Date.now();
      setTimeout(function () { finish(false); }, FETCH_TIMEOUT_MS);
    });
  }

  function probeFetch(url) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
      fetch(url + "?_=" + Date.now(), { method: "GET", cache: "no-store", signal: ctrl.signal })
        .then(function (res) { clearTimeout(t); resolve({ ok: res.ok, latency_ms: Date.now() - start }); })
        .catch(function () { clearTimeout(t); resolve({ ok: false, latency_ms: Date.now() - start }); });
    });
  }

  async function runProbes() {
    var probeServices = SERVICES.filter(function (s) { return s.source === "probe"; });
    var results = await Promise.all(probeServices.map(function (s) {
      var fn = s.probeMethod === "fetch" ? probeFetch : probeImage;
      return fn(s.probeUrl).then(function (r) {
        return { id: s.id, ok: r.ok, latency_ms: r.latency_ms };
      });
    }));
    results.forEach(function (r) {
      probeResults[r.id] = { ok: r.ok, latency_ms: r.latency_ms, last_check: Date.now() };
    });
  }

  // ─── Fetch loop ──────────────────────────────────────────────────────────
  async function loadStatus() {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    try {
      var res = await fetch(API_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error("HTTP " + res.status);
      lastData = await res.json();
      lastFromCache = false;
      lastTimestamp = Date.now();
      failureCount = 0;
      saveCache(lastData);
    } catch (err) {
      clearTimeout(to);
      failureCount += 1;
      // Don't flip to "cached" view on first failure — could just be a
      // 200ms blip. Only after OFFLINE_THRESHOLD consecutive failures
      // do we accept the cached state as the visible source of truth.
      if (failureCount >= OFFLINE_THRESHOLD) {
        var cached = loadCache();
        if (cached && cached.data) {
          lastData = cached.data;
          lastFromCache = true;
          lastTimestamp = cached.timestamp;
        } else {
          // Hard outage, no cache. Synthesize a major-outage shape.
          lastData = {
            overall: "major_outage",
            checked_at: new Date().toISOString(),
            endpoints: [],
            incidents: [],
            active_incident_count: 0,
          };
          lastFromCache = false;
          lastTimestamp = Date.now();
        }
      }
      // First failure: keep showing whatever we had, with no banner. The
      // next 30s tick will retry; if it still fails we surface.
    }
  }

  async function tick() {
    // Probes + status fetch run in parallel; render once both settle so
    // the page doesn't flicker if probes finish first.
    await Promise.all([loadStatus(), runProbes()]);
    render();
  }

  // ─── Init ────────────────────────────────────────────────────────────────
  $mastheadDate.textContent = fmtDate(new Date());

  // Render an immediate cached view if we have one — avoids the
  // "Loading status…" flash on repeat visits.
  var seed = loadCache();
  if (seed && seed.data) {
    lastData = seed.data;
    lastFromCache = true;
    lastTimestamp = seed.timestamp;
    render();
  }

  tick();
  setInterval(tick, POLL_MS);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") tick();
  });
})();
