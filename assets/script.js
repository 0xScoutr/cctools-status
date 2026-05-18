/**
 * CCTools Status — client.
 *
 * Polls api.cctools.network/api/v1/public/status every 30 seconds,
 * renders the snapshot, falls back to localStorage on fetch failure.
 *
 * Zero deps. Vanilla DOM. Survives a backend outage by surfacing
 * the last cached state with a clear "API unreachable" banner.
 */

(function () {
  "use strict";

  var API_URL = "https://api.cctools.network/api/v1/public/status";
  var POLL_MS = 30 * 1000;
  var CACHE_KEY = "cctools.status.last";
  var CACHE_MAX_AGE_MS = 10 * 60 * 1000; // surface "stale" warning after 10min

  var GROUP_ORDER = ["meta", "ecosystem", "users", "earn", "leaderboard", "auth"];
  var GROUP_LABELS = {
    meta: "Meta",
    ecosystem: "Ecosystem",
    users: "Users",
    earn: "Earn",
    leaderboard: "Leaderboard",
    auth: "Auth",
  };

  // ─── DOM refs ────────────────────────────────────────────────────────────
  var $overall = document.getElementById("overall");
  var $overallIcon = document.getElementById("overall-icon");
  var $overallTitle = document.getElementById("overall-title");
  var $overallSub = document.getElementById("overall-sub");
  var $overallStamp = document.getElementById("overall-stamp");

  var $offlineBanner = document.getElementById("offline-banner");
  var $offlineDetail = document.getElementById("offline-detail");

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

  // Log scale for sparkline bar height so 50ms / 500ms / 5000ms are
  // visually distinct. Linear was useless past ~1s.
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

  // ─── Rendering ───────────────────────────────────────────────────────────
  function renderOverall(data, fromCache, cacheAgeMs) {
    var overall = data.overall || "operational";

    // Clear previous mode class
    $overall.className = "overall-card overall-" + overall;

    var iconMap = {
      operational: "✓",
      degraded: "!",
      major_outage: "×",
    };
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
      "Last checked " +
      relTime(checkedAt) +
      (fromCache ? " · cached" : "");
  }

  function renderIncidents(incidents) {
    var active = [];
    var resolved = [];
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

    var html = items
      .map(function (i) {
        var sevColor =
          i.severity === "critical" || i.severity === "major"
            ? "red"
            : i.severity === "maintenance"
            ? "blue"
            : "amber";
        var statusColor =
          i.status === "resolved"
            ? "lime"
            : i.status === "monitoring"
            ? "blue"
            : "amber";

        var bodyHtml = i.body
          ? '<p class="incident-body">' + escapeHtml(i.body) + "</p>"
          : "";
        var resolvedHtml = i.resolved_at
          ? ' <span class="dot-sep">·</span> Resolved ' +
            escapeHtml(relTime(i.resolved_at))
          : "";
        var endpointsHtml =
          i.affected_endpoints && i.affected_endpoints.length
            ? ' <span class="dot-sep">·</span> ' +
              i.affected_endpoints.length +
              " endpoint" +
              (i.affected_endpoints.length > 1 ? "s" : "")
            : "";

        return (
          '<div class="incident-card">' +
          '  <div class="incident-head">' +
          '    <h3 class="incident-title">' +
          escapeHtml(i.title || "Untitled") +
          "</h3>" +
          '    <span class="badge ' +
          sevColor +
          '">' +
          escapeHtml(i.severity) +
          "</span>" +
          '    <span class="badge ' +
          statusColor +
          '">' +
          escapeHtml(i.status) +
          "</span>" +
          "  </div>" +
          bodyHtml +
          '  <div class="incident-meta">Started ' +
          escapeHtml(relTime(i.created_at)) +
          resolvedHtml +
          endpointsHtml +
          "  </div>" +
          "</div>"
        );
      })
      .join("");

    list.innerHTML = html;
  }

  function renderEndpoints(endpoints) {
    if (!endpoints || !endpoints.length) {
      $endpointsCard.innerHTML =
        '<div class="endpoints-empty">No endpoints reporting yet.</div>';
      return;
    }

    var byGroup = {};
    endpoints.forEach(function (e) {
      var g = e.group || "meta";
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(e);
    });

    var html = GROUP_ORDER.filter(function (g) {
      return byGroup[g] && byGroup[g].length;
    })
      .map(function (g) {
        var head =
          '<div class="group-heading">' + escapeHtml(GROUP_LABELS[g]) + "</div>";
        var rows = byGroup[g].map(renderEndpointRow).join("");
        return head + rows;
      })
      .join("");

    $endpointsCard.innerHTML = html;
  }

  function renderEndpointRow(ep) {
    var ok = ep.last_ok;
    var dotCls = ok === true ? "dot-ok" : ok === false ? "dot-down" : "dot-unknown";
    var statusLabel =
      ok == null
        ? "No data"
        : ok
        ? "Operational"
        : "Down (HTTP " + (ep.last_status_code || "?") + ")";

    // Sparkline (last 30 recent points)
    var recent = (ep.recent || []).slice(-30);
    var bars = recent
      .map(function (r) {
        return (
          '<span class="spark-bar' +
          (r.ok ? "" : " bar-down") +
          '" style="height:' +
          barHeight(r.latency_ms) +
          'px" title="' +
          escapeHtml(
            r.status_code + " · " + r.latency_ms + "ms · " + relTime(r.ts)
          ) +
          '"></span>'
        );
      })
      .join("");

    var statsLine = [];
    if (ep.uptime_pct_1h != null)
      statsLine.push(ep.uptime_pct_1h + "% · 1h");
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

  function render(data, fromCache, cacheAgeMs) {
    renderOverall(data, fromCache, cacheAgeMs);
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

      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }
      var data = await res.json();
      saveCache(data);
      hideOffline();
      render(data, false, 0);
    } catch (err) {
      clearTimeout(timeout);
      // Try to render last known cache.
      var cached = loadCache();
      if (cached && cached.data) {
        var age = Date.now() - cached.timestamp;
        showOffline(
          "Showing last known data from " + relTime(new Date(cached.timestamp).toISOString())
        );
        render(cached.data, true, age);
      } else {
        // No cache + no network. Render a hard-down state.
        var down = {
          overall: "major_outage",
          checked_at: new Date().toISOString(),
          endpoints: [],
          incidents: [],
          active_incident_count: 0,
        };
        showOffline("Cannot reach the status API and no cache available.");
        render(down, false, 0);
      }
    }
  }

  // Boot + poll
  load();
  setInterval(load, POLL_MS);

  // Refresh when the tab comes back from background
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });
})();
