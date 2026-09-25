// Probes every service in site/services.json and writes the data the status
// page reads:
//   <data-dir>/status.json               latest result per service (overwritten each run)
//   <data-dir>/history.json              per-day check counts per service, last 90 days
//   <data-dir>/checks/YYYY-MM.ndjson     every check ever made, one line each (append-only)
//   <data-dir>/sla.json                  monthly SLA figures per service (see sla.mjs)
//   <data-dir>/detected-incidents.json   runs of failed checks, as incidents
//
// Runs from .github/workflows/status.yml on a cron. The data dir is read back
// from the previous run (the `status-data` branch), so it accumulates.
//
// Usage: node scripts/check.mjs [data-dir]   (default: site/data)

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { computeMonth, detectIncidents, monthKey, monthBounds } from './sla.mjs';

const dataDir = process.argv[2] || 'site/data';
const TIMEOUT_MS = 10_000;
const SLOW_MS = 3_000; // slower than this counts as degraded
const HISTORY_DAYS = 90;

const { services } = JSON.parse(await readFile('site/services.json', 'utf8'));

// A missing file means "nothing yet"; anything else (a truncated or corrupt
// file) must stop the run — silently starting over would wipe SLA history.
async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readJson(file, fallback) {
  const text = await readText(file);
  return text === null ? fallback : JSON.parse(text);
}

async function readChecks(file) {
  const text = await readText(file);
  return text === null ? [] : text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function get(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function probe(service) {
  const started = performance.now();
  try {
    const res = await fetch(service.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'teramot-status/1.0 (+https://status.teramot.com)' },
    });
    const body = await res.text();
    const latency = Math.round(performance.now() - started);
    if (!res.ok) return { status: 'down', code: res.status, latency_ms: latency, error: `HTTP ${res.status}` };

    for (const [key, want] of Object.entries(service.expect?.json || {})) {
      let got;
      try {
        got = get(JSON.parse(body), key);
      } catch {
        return { status: 'down', code: res.status, latency_ms: latency, error: 'Respuesta no es JSON' };
      }
      // The service itself says it is not healthy: that is down, not merely slow.
      if (got !== want) {
        return { status: 'down', code: res.status, latency_ms: latency, error: `${key}=${got}` };
      }
    }
    // Guards against a 200 that isn't the service (an error page, a parked domain).
    for (const needle of service.expect?.contains || []) {
      if (!body.includes(needle)) {
        return { status: 'down', code: res.status, latency_ms: latency, error: `Falta "${needle}" en la respuesta` };
      }
    }
    return { status: latency > SLOW_MS ? 'degraded' : 'up', code: res.status, latency_ms: latency };
  } catch (err) {
    const latency = Math.round(performance.now() - started);
    const error = err.name === 'TimeoutError' ? `Timeout (${TIMEOUT_MS / 1000}s)` : err.cause?.code || err.message;
    return { status: 'down', code: null, latency_ms: latency, error };
  }
}

// One retry before declaring a service down, so a single dropped packet from
// the CI runner doesn't paint the page red.
async function check(service) {
  let result = await probe(service);
  if (result.status === 'down') {
    await new Promise((r) => setTimeout(r, 2_000));
    result = await probe(service);
  }
  return { id: service.id, ...result };
}

const now = new Date();
const today = now.toISOString().slice(0, 10);
const results = await Promise.all(services.map(check));

const rank = { up: 0, degraded: 1, down: 2 };
const worst = results.reduce((w, r) => (rank[r.status] > rank[w] ? r.status : w), 'up');

await mkdir(dataDir, { recursive: true });
await writeFile(
  path.join(dataDir, 'status.json'),
  JSON.stringify({ checked_at: now.toISOString(), overall: worst, services: results }, null, 2) + '\n',
);

const history = await readJson(path.join(dataDir, 'history.json'), { days: {} });
const cutoff = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
for (const r of results) {
  const perDay = (history.days[r.id] ||= {});
  const day = (perDay[today] ||= { up: 0, degraded: 0, down: 0 });
  day[r.status] += 1;
  for (const d of Object.keys(perDay)) if (d < cutoff) delete perDay[d];
}
// Drop services that were removed from services.json.
for (const id of Object.keys(history.days)) if (!services.some((s) => s.id === id)) delete history.days[id];
history.updated_at = now.toISOString();
await writeFile(path.join(dataDir, 'history.json'), JSON.stringify(history) + '\n');

// Raw log: the record the SLA is computed from. Only ever appended to.
const checksDir = path.join(dataDir, 'checks');
await mkdir(checksDir, { recursive: true });
const month = monthKey(now);
await appendFile(
  path.join(checksDir, `${month}.ndjson`),
  results
    .map((r) => JSON.stringify({ t: now.toISOString(), id: r.id, s: r.status, ms: r.latency_ms, code: r.code, ...(r.error && { err: r.error }) }))
    .join('\n') + '\n',
);

// SLA: recompute this month and the previous one (so the last minutes of a
// month get closed out by the first run of the next); older months stay as
// they were last computed.
const config = await readJson('site/sla.json', {});
const maintenance = await readJson('site/maintenance.json', []);
const inScope = config.services || services.map((s) => s.id);
const opts = { now: now.getTime(), maintenance, degradedIsDown: !!config.degraded_counts_as_down };
const prevMonth = monthKey(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

const sla = await readJson(path.join(dataDir, 'sla.json'), { months: {} });
const recentChecks = [];
for (const key of [prevMonth, month]) {
  const checks = await readChecks(path.join(checksDir, `${key}.ndjson`));
  if (!checks.length) continue;
  recentChecks.push(...checks);
  sla.months[key] = { final: key !== month, services: computeMonth(checks, key, inScope, opts) };
}
sla.target_pct = config.target_pct ?? null;
sla.updated_at = now.toISOString();
await writeFile(path.join(dataDir, 'sla.json'), JSON.stringify(sla, null, 2) + '\n');

// Incidents from the last two months are re-derived; older ones are kept.
const detectedFile = path.join(dataDir, 'detected-incidents.json');
const recentFrom = new Date(monthBounds(prevMonth).start).toISOString();
const older = (await readJson(detectedFile, { incidents: [] })).incidents.filter((i) => i.start < recentFrom);
const incidents = [...detectIncidents(recentChecks, opts), ...older];
await writeFile(detectedFile, JSON.stringify({ updated_at: now.toISOString(), incidents }, null, 2) + '\n');

for (const r of results) {
  console.log(`${r.status.padEnd(8)} ${r.id.padEnd(8)} ${String(r.latency_ms).padStart(5)}ms ${r.error || ''}`);
}
console.log(`overall: ${worst}`);
