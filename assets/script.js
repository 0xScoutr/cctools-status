/**
 * CCTools Status — client.
 *
 * Two data sources, both kept in sync on the UI:
 *  1. api.cctools.network/api/v1/public/status  (server-side health checker)
 *  2. Browser-side liveness probes for the public surfaces (cctools.network,
 *     api.cctools.network root, docs.cctools.network) — gives a "what the
 *     visitor sees" signal that complements the backend's loopback probes.
 *
 * Polls every 30s. Falls back to localStorage on fetch failure. Surfaces
 * a clear "API unreachable" banner so the status page is most useful
 * exactly when the backend is least reachable.
 */

(function () {
  "use strict";

  var API_URL = "https://api.cctools.network/api/v1/public/status";
  var POLL_MS = 30 * 1000;
  var CACHE_KEY = "cctools.status.last";

  // Service groups we surface as top-level cards. Order is intentional:
  // most-used surfaces first.
  var SERVICE_DEFS = [
    { group: "ecosystem", title: "Ecosystem", desc: "Projects, trending, categories, rankings" },
    { group: "users", title: "Users", desc: "Profiles, badges, contributions, activity" },
    { group: "earn", title: "Earn", desc: "Opportunities + campaigns" },
    { group: "leaderboard", title: "Leaderboard", desc: "XP rankings" },
    { group: "meta", title: "Documentation", desc: "OpenAPI spec + tooling" },
  ];

  var GROUP_LABELS = {
    meta: "Meta",
    ecosystem: "Ecosystem",
    users: "Users",
    earn: "Earn",
    leaderboard: "Leaderboard",
    auth: "Auth",
  };

  // Browser-side liveness checks. Image-probe trick: if the browser can
  // load /favicon.ico from the target host, we treat it as up. CORS-free,
  // ~50ms in steady state, instantly returns error event on DNS fail.
  var INFRA_PROBES = [
    { id: "web", title: "Public site", host: "cctools.network", url: "https://cctools.network/favicon.ico" },
    { id: "api", title: "API gateway", host: "api.cctools.network", url: "https://api.cctools.network/api/v1/openapi.json", method: "fetch" },
    { id: "docs", title: "Documentation", host: "docs.cctools.network", url: "https://docs.cctools.network/favicon.ico" },
  ];

  // ─── DOM refs ────────────────────────────────────────────────────────────
  var $overall = document.getElementById("overall");
  var $overallIcon = document.getElementById("overall-icon");
  var $overallTitle = document.getElementById("overall-title");
  var $overallSub = document.getElementById("overall-sub");
  var $overallStamp = document.getElementById("overall-stamp");

  var $offlineBanner = document.getElementById("offline-banner");
  var $offlineDetail = document.getElementById("offline-detail");

  var $statServices = document.getElementById("stat-services");
  var $statEndpoints = document.getElementById("stat-endpoints");
  var $statUptime = document.getElementById("stat-uptime");
  var $statLatency = document.getElementById("stat-latency");

  var $servicesRow = document.getElementById("services-row");
  var $svcCount = document.getElementById("svc-count");
  var $infraRow = document.getElementById("infra-row");

  var $activeSection = document.getElementById("active-incidents");
  var $activeList = document.getElementById("active-incidents-list");
  var $resolvedSection = document.getElementById("resolved-incidents");
  var $resolvedList = document.getElementById("resolved-incidents-list");

  var $endpointsCard = document.getElementById("endpoints-card");

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function relTime(iso) {
    if (!iso) return "—";
    var d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return Math.floor(d) + "s ago";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
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

  // Log scale so 50ms / 500ms / 5000ms are visually distinct.
  function barHeight(latencyMs) {
    var v = Math.max(1, latencyMs || 1);
    var h = 4 + Math.round(Math.log10(v) * 5);
    return Math.max(4, Math.min(24, h));
  }

  // ─── Cache (localStorage) ────────────────────────────────────────────────
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.data || !parsed.timestamp) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ data: data, timestamp: Date.now() })
      );
    } catch (e) {
      // private mode, quota, etc — non-fatal
    }
  }

  // ─── Service aggregation ─────────────────────────────────────────────────
  function aggregateService(group, endpoints) {
    var inGroup = endpoints.filter(function (e) { return e.group === group; });
    if (!inGroup.length) {
      return { status: "unknown", checks: 0, ok_count: 0, uptime_pct: null, avg_latency: null };
    }
    var sampled = inGroup.filter(function (e) { return e.last_ok !== null; });
    var downCount = sampled.filter(function (e) { return e.last_ok === false; }).length;

    var status = "unknown";
    if (sampled.length === 0) status = "unknown";
    else if (downCount === 0) status = "operational";
    else if (downCount >= Math.ceil(sampled.length / 2)) status = "major_outage";
    else status = "degraded";

    var uptimeAvg = null;
    var uptimeSamples = sampled.filter(function (e) { return e.uptime_pct_1h != null; });
    if (uptimeSamples.length) {
      var sum = uptimeSamples.reduce(function (a, e) { return a + e.uptime_pct_1h; }, 0);
      uptimeAvg = Math.round((sum / uptimeSamples.length) * 10) / 10;
    }

    var latencyAvg = null;
    var latSamples = sampled.filter(function (e) { return e.avg_latency_1h != null; });
    if (latSamples.length) {
      latencyAvg = Math.round(
        latSamples.reduce(function (a, e) { return a + e.avg_latency_1h; }, 0) / latSamples.length
      );
    }

    return {
      status: status,
      checks: inGroup.length,
      ok_count: sampled.length - downCount,
      uptime_pct: uptimeAvg,
      avg_latency: latencyAvg,
    };
  }

  function renderServices(endpoints) {
    var html = SERVICE_DEFS.map(function (svc) {
      var agg = aggregateService(svc.group, endpoints);
      var statusLabel = {
        operational: "Operational",
        degraded: "Degraded",
        major_outage: "Outage",
        unknown: "No data",
      }[agg.status];

      var metaLine = "<strong>" + agg.checks + "</strong> check" + (agg.checks === 1 ? "" : "s");
      if (agg.uptime_pct != null) metaLine += " · " + agg.uptime_pct + "% · 1h";
      if (agg.avg_latency != null) metaLine += " · " + agg.avg_latency + "ms";

      return (
        '<div class="service-card svc-' + agg.status + '">' +
        '  <div class="service-head">' +
        '    <span class="service-title">' + escapeHtml(svc.title) + "</span>" +
        '    <span class="service-status s-' + agg.status + '">' + statusLabel + "</span>" +
        "  </div>" +
        '  <div class="service-meta">' + metaLine + "</div>" +
        "</div>"
      );
    }).join("");

    $servicesRow.innerHTML = html;
    $svcCount.textContent = SERVICE_DEFS.length + " services";
  }

  // ─── Stats row ───────────────────────────────────────────────────────────
  function renderStats(data, infraStates) {
    var endpoints = data.endpoints || [];
    var sampled = endpoints.filter(function (e) { return e.last_ok !== null; });

    // Combined service count = API service groups (5) + infrastructure (3)
    var serviceTotal = SERVICE_DEFS.length + INFRA_PROBES.length;
    $statServices.textContent = String(serviceTotal);

    $statEndpoints.textContent = String(endpoints.length);

    var uptimeSamples = sampled.filter(function (e) { return e.uptime_pct_1h != null; });
    if (uptimeSamples.length) {
      var sum = uptimeSamples.reduce(function (a, e) { return a + e.uptime_pct_1h; }, 0);
      var avg = (sum / uptimeSamples.length).toFixed(1);
      $statUptime.textContent = avg + "%";
    } else {
      $statUptime.textContent = "—";
    }

    var latSamples = sampled.filter(function (e) { return e.avg_latency_1h != null; });
    if (latSamples.length) {
      var lat = Math.round(
        latSamples.reduce(function (a, e) { return a + e.avg_latency_1h; }, 0) / latSamples.length
      );
      $statLatency.textContent = lat + "ms";
    } else {
      $statLatency.textContent = "—";
    }
  }

  // ─── Infrastructure (browser-side probes) ────────────────────────────────
  var infraState = {}; // id → { ok: boolean|null, latency_ms, last_check }

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
      // cache buster avoids stale browser cache hiding outages
      img.src = url + "?_=" + Date.now();
      setTimeout(function () { finish(false); }, 8000);
    });
  }

  function probeFetch(url) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 8000);
      fetch(url + "?_=" + Date.now(), { method: "GET", cache: "no-store", signal: ctrl.signal })
        .then(function (res) {
          clearTimeout(t);
          resolve({ ok: res.ok, latency_ms: Date.now() - start });
        })
        .catch(function () {
          clearTimeout(t);
          resolve({ ok: false, latency_ms: Date.now() - start });
        });
    });
  }

  async function runInfraProbes() {
    var results = await Promise.all(
      INFRA_PROBES.map(function (p) {
        return (p.method === "fetch" ? probeFetch(p.url) : probeImage(p.url)).then(function (r) {
          return { id: p.id, title: p.title, host: p.host, ok: r.ok, latency_ms: r.latency_ms };
        });
      }),
    );
    results.forEach(function (r) {
      infraState[r.id] = { ok: r.ok, latency_ms: r.latency_ms, last_check: Date.now() };
    });
    renderInfra();
  }

  function renderInfra() {
    var html = INFRA_PROBES.map(function (p) {
      var s = infraState[p.id] || { ok: null, latency_ms: null, last_check: null };
      var status = s.ok === null ? "unknown" : s.ok ? "operational" : "major_outage";
      var statusLabel = {
        operational: "Reachable",
        degraded: "Slow",
        major_outage: "Unreachable",
        unknown: "Checking…",
      }[status];

      var metaLine = "<strong>" + escapeHtml(p.host) + "</strong>";
      if (s.latency_ms != null) metaLine += " · " + s.latency_ms + "ms";

      return (
        '<div class="service-card svc-' + status + '">' +
        '  <div class="service-head">' +
        '    <span class="service-title">' + escapeHtml(p.title) + "</span>" +
        '    <span class="service-status s-' + status + '">' + statusLabel + "</span>" +
        "  </div>" +
        '  <div class="service-meta">' + metaLine + "</div>" +
        "</div>"
      );
    }).join("");
    $infraRow.innerHTML = html;
  }

  // ─── Overall + incidents + endpoints (unchanged from before) ────────────
  function renderOverall(data, fromCache) {
    var overall = data.overall || "operational";
    $overall.className = "overall-card overall-" + overall;

    var iconMap = { operational: "✓", degraded: "!", major_outage: "×" };
    var titleMap = {
      operational: "All systems operational",
      degraded: "Degraded performance",
      major_outage: "Major outage",
    };

    $overallIcon.textContent = iconMap[overall] || "?";
    $overallTitle.textContent = titleMap[overall] || "Unknown";

    var activeCount = data.active_incident_count || 0;
    if (overall === "operational") {
      $overallSub.textContent = "Every monitored endpoint is healthy.";
    } else if (activeCount > 0) {
      $overallSub.textContent =
        activeCount + " active incident" + (activeCount > 1 ? "s" : "") + ".";
    } else {
      $overallSub.textContent = "Some endpoints are not fully healthy.";
    }

    var checkedAt = data.checked_at || new Date().toISOString();
    $overallStamp.textContent =
      "Last checked " + relTime(checkedAt) + (fromCache ? " · cached" : "");
  }

  function renderIncidents(incidents) {
    var active = [], resolved = [];
    (incidents || []).forEach(function (i) {
      if (i.status === "resolved") resolved.push(i);
      else active.push(i);
    });
    renderIncidentList($activeSection, $activeList, active);
    renderIncidentList($resolvedSection, $resolvedList, resolved);
  }

  function renderIncidentList(section, list, items) {
    if (!items.length) {
      section.hidden = true;
      list.innerHTML = "";
      return;
    }
    section.hidden = false;
    var html = items.map(function (i) {
      var sevColor =
        i.severity === "critical" || i.severity === "major" ? "red" :
        i.severity === "maintenance" ? "blue" : "amber";
      var statusColor =
        i.status === "resolved" ? "green" :
        i.status === "monitoring" ? "blue" : "amber";
      var bodyHtml = i.body ? '<p class="incident-body">' + escapeHtml(i.body) + "</p>" : "";
      var resolvedHtml = i.resolved_at
        ? ' <span class="dot-sep">·</span> Resolved ' + escapeHtml(relTime(i.resolved_at))
        : "";
      var endpointsHtml = i.affected_endpoints && i.affected_endpoints.length
        ? ' <span class="dot-sep">·</span> ' + i.affected_endpoints.length + " endpoint" +
          (i.affected_endpoints.length > 1 ? "s" : "")
        : "";
      return (
        '<div class="incident-card">' +
        '  <div class="incident-head">' +
        '    <h3 class="incident-title">' + escapeHtml(i.title || "Untitled") + "</h3>" +
        '    <span class="badge ' + sevColor + '">' + escapeHtml(i.severity) + "</span>" +
        '    <span class="badge ' + statusColor + '">' + escapeHtml(i.status) + "</span>" +
        "  </div>" +
        bodyHtml +
        '  <div class="incident-meta">Started ' + escapeHtml(relTime(i.created_at)) +
        resolvedHtml + endpointsHtml + "</div>" +
        "</div>"
      );
    }).join("");
    list.innerHTML = html;
  }

  function renderEndpoints(endpoints) {
    if (!endpoints || !endpoints.length) {
      $endpointsCard.innerHTML = '<div class="endpoints-empty">No endpoints reporting yet.</div>';
      return;
    }
    var byGroup = {};
    endpoints.forEach(function (e) {
      var g = e.group || "meta";
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(e);
    });
    var groupOrder = ["ecosystem", "users", "earn", "leaderboard", "meta", "auth"];
    var html = groupOrder.filter(function (g) {
      return byGroup[g] && byGroup[g].length;
    }).map(function (g) {
      var head = '<div class="group-heading">' + escapeHtml(GROUP_LABELS[g] || g) + "</div>";
      var rows = byGroup[g].map(renderEndpointRow).join("");
      return head + rows;
    }).join("");
    $endpointsCard.innerHTML = html;
  }

  function renderEndpointRow(ep) {
    var ok = ep.last_ok;
    var dotCls = ok === true ? "dot-ok" : ok === false ? "dot-down" : "dot-unknown";
    var statusLabel =
      ok == null ? "No data" :
      ok ? "Operational" : "Down (HTTP " + (ep.last_status_code || "?") + ")";

    var recent = (ep.recent || []).slice(-30);
    var bars = recent.map(function (r) {
      return (
        '<span class="spark-bar' + (r.ok ? "" : " bar-down") +
        '" style="height:' + barHeight(r.latency_ms) +
        'px" title="' + escapeHtml(r.status_code + " · " + r.latency_ms + "ms · " + relTime(r.ts)) + '"></span>'
      );
    }).join("");

    var statsLine = [];
    if (ep.uptime_pct_1h != null) statsLine.push(ep.uptime_pct_1h + "% · 1h");
    if (ep.avg_latency_1h != null) statsLine.push(ep.avg_latency_1h + "ms");
    var statsSub = statsLine.join(" · ") || "—";

    return (
      '<div class="endpoint-row">' +
      '  <span class="endpoint-dot ' + dotCls + '" aria-hidden="true"></span>' +
      '  <div class="endpoint-main">' +
      '    <div class="endpoint-label">' + escapeHtml(ep.label || ep.path) + "</div>" +
      '    <code class="endpoint-path">' + escapeHtml(ep.path) + "</code>" +
      "  </div>" +
      '  <div class="sparkline" aria-hidden="true">' + bars + "</div>" +
      '  <div class="endpoint-stats">' +
      '    <div class="stats-title">' + escapeHtml(statusLabel) + "</div>" +
      '    <div class="stats-sub">' + escapeHtml(statsSub) + "</div>" +
      "  </div>" +
      "</div>"
    );
  }

  function render(data, fromCache) {
    renderOverall(data, fromCache);
    renderStats(data, infraState);
    renderServices(data.endpoints || []);
    renderIncidents(data.incidents || []);
    renderEndpoints(data.endpoints || []);
  }

  function showOffline(detail) {
    $offlineBanner.hidden = false;
    if (detail) $offlineDetail.textContent = detail;
  }
  function hideOffline() {
    $offlineBanner.hidden = true;
  }

  // ─── Fetch loop ──────────────────────────────────────────────────────────
  async function load() {
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, 10000);

    try {
      var res = await fetch(API_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      saveCache(data);
      hideOffline();
      render(data, false);
    } catch (err) {
      clearTimeout(timeout);
      var cached = loadCache();
      if (cached && cached.data) {
        showOffline("Showing last known data from " + relTime(new Date(cached.timestamp).toISOString()));
        render(cached.data, true);
      } else {
        var down = {
          overall: "major_outage",
          checked_at: new Date().toISOString(),
          endpoints: [],
          incidents: [],
          active_incident_count: 0,
        };
        showOffline("Cannot reach the status API and no cache available.");
        render(down, false);
      }
    }
  }

  // Boot + poll
  load();
  runInfraProbes();
  setInterval(load, POLL_MS);
  setInterval(runInfraProbes, POLL_MS);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      load();
      runInfraProbes();
    }
  });
})();
