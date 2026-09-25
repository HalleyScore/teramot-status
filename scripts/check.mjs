// Probes every service in site/services.json and writes the data the status
// page reads:
//   <data-dir>/status.json   latest result per service (overwritten each run)
//   <data-dir>/history.json  per-day check counts per service, last 90 days
//
// Runs from .github/workflows/status.yml on a cron. history.json is read back
// from the previous run (the `status-data` branch), so it accumulates.
//
// Usage: node scripts/check.mjs [data-dir]   (default: site/data)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const dataDir = process.argv[2] || 'site/data';
const TIMEOUT_MS = 10_000;
const SLOW_MS = 3_000; // slower than this counts as degraded
const HISTORY_DAYS = 90;

const { services } = JSON.parse(await readFile('site/services.json', 'utf8'));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
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
      if (got !== want) {
        return { status: 'degraded', code: res.status, latency_ms: latency, error: `${key}=${got}` };
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

for (const r of results) {
  console.log(`${r.status.padEnd(8)} ${r.id.padEnd(8)} ${String(r.latency_ms).padStart(5)}ms ${r.error || ''}`);
}
console.log(`overall: ${worst}`);
