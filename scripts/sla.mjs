// SLA math over the raw check log. Pure functions — no I/O — so they can be
// unit-tested (scripts/sla.test.mjs) and re-run over any month's checks.
//
// A check is { t: ISO time, id: service id, s: 'up' | 'degraded' | 'down', ... }.
//
// Time model: each check stands for the service's state from its own time
// until the next check, capped at MAX_GAP_MS. Past that cap we don't know what
// happened (the monitor itself didn't run), so the time counts as *uncovered*
// rather than up or down. That's what `coverage_pct` reports.
//
// Downtime is therefore "first failed check -> first healthy check", which is
// how incidents are usually measured, and it's independent of how regularly
// the cron fired.

export const MAX_GAP_MS = 15 * 60 * 1000;

export function monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

export function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

// Milliseconds of [from, to) that fall outside every maintenance window that
// applies to `id`.
function minusMaintenance(from, to, id, maintenance) {
  let ms = to - from;
  for (const w of maintenance) {
    if (w.services !== 'all' && !(w.services || []).includes(id)) continue;
    const a = Math.max(from, Date.parse(w.start));
    const b = Math.min(to, Date.parse(w.end));
    if (b > a) ms -= b - a;
  }
  return Math.max(0, ms);
}

function isDown(check, degradedIsDown) {
  return check.s === 'down' || (degradedIsDown && check.s === 'degraded');
}

// Per-service SLA figures for one calendar month (UTC).
//   checks       all checks for that month, any order, any services
//   serviceIds   services to report on
//   now          ms timestamp; the current month is only measured up to here
export function computeMonth(checks, key, serviceIds, { now = Date.now(), maintenance = [], degradedIsDown = false, maxGapMs = MAX_GAP_MS } = {}) {
  const { start, end } = monthBounds(key);
  const until = Math.min(end, now);
  const byService = groupChecks(checks);
  const out = {};

  for (const id of serviceIds) {
    const list = byService[id] || [];
    let covered = 0;
    let downtime = 0;
    let downChecks = 0;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const t = Date.parse(c.t);
      if (!inMonth(t, start, end, now)) continue;
      const next = i + 1 < list.length ? Date.parse(list[i + 1].t) : until;
      const to = Math.min(next, t + maxGapMs, until);
      const span = minusMaintenance(t, to, id, maintenance);
      covered += span;
      if (isDown(c, degradedIsDown)) {
        downtime += span;
        downChecks += 1;
      }
    }

    const elapsed = minusMaintenance(start, until, id, maintenance);
    out[id] = {
      uptime_pct: covered ? round(100 * (1 - downtime / covered), 3) : null,
      downtime_min: round(downtime / 60_000, 1),
      covered_min: round(covered / 60_000, 1),
      elapsed_min: round(elapsed / 60_000, 1),
      coverage_pct: elapsed ? round(Math.min(100, (100 * covered) / elapsed), 1) : null,
      checks: list.filter((c) => inMonth(Date.parse(c.t), start, end, now)).length,
      down_checks: downChecks,
    };
  }
  return out;
}

// Runs of consecutive failed checks per service, as incidents:
//   { id, start, end (null while ongoing), duration_min, checks }
// A run that falls entirely inside a maintenance window is dropped.
export function detectIncidents(checks, { now = Date.now(), maintenance = [], degradedIsDown = false } = {}) {
  const incidents = [];
  for (const [id, list] of Object.entries(groupChecks(checks))) {
    let open = null;
    for (const c of list) {
      if (isDown(c, degradedIsDown)) {
        if (!open) open = { id, start: c.t, end: null, checks: 0 };
        open.checks += 1;
      } else if (open) {
        open.end = c.t;
        incidents.push(open);
        open = null;
      }
    }
    if (open) incidents.push(open);
  }
  return incidents
    .map((inc) => {
      const from = Date.parse(inc.start);
      const to = inc.end ? Date.parse(inc.end) : now;
      return { ...inc, duration_min: round(minusMaintenance(from, to, inc.id, maintenance) / 60_000, 1) };
    })
    .filter((inc) => inc.duration_min > 0 || inc.end === null)
    .sort((a, b) => b.start.localeCompare(a.start));
}

// A check made at exactly `now` (the run that is computing this) counts.
function inMonth(t, start, end, now) {
  return t >= start && t < end && t <= now;
}

function groupChecks(checks) {
  const by = {};
  for (const c of checks) (by[c.id] ||= []).push(c);
  for (const list of Object.values(by)) list.sort((a, b) => a.t.localeCompare(b.t));
  return by;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
