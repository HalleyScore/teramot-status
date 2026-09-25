// Run: node --test scripts/sla.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonth, detectIncidents, monthBounds } from './sla.mjs';

const MIN = 60_000;
const base = Date.UTC(2026, 8, 1); // 2026-09-01T00:00Z
const at = (min) => new Date(base + min * MIN).toISOString();
const check = (min, s, id = 'app') => ({ t: at(min), id, s });

test('monthBounds covers the whole UTC month', () => {
  const { start, end } = monthBounds('2026-09');
  assert.equal(new Date(start).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-10-01T00:00:00.000Z');
});

test('downtime runs from first failed check to first healthy one', () => {
  const checks = [check(0, 'up'), check(5, 'down'), check(10, 'down'), check(15, 'up')];
  const r = computeMonth(checks, '2026-09', ['app'], { now: base + 20 * MIN })['app'];
  assert.equal(r.downtime_min, 10);
  assert.equal(r.covered_min, 20);
  assert.equal(r.uptime_pct, 50);
  assert.equal(r.coverage_pct, 100);
  assert.equal(r.down_checks, 2);
});

test('gaps longer than the cap count as uncovered, not as up or down', () => {
  // One check, then nothing for an hour.
  const checks = [check(0, 'down'), check(60, 'up')];
  const r = computeMonth(checks, '2026-09', ['app'], { now: base + 60 * MIN, maxGapMs: 15 * MIN })['app'];
  assert.equal(r.downtime_min, 15);
  assert.equal(r.covered_min, 15);
  assert.equal(r.coverage_pct, 25);
  assert.equal(r.uptime_pct, 0);
});

test('degraded is available unless configured otherwise', () => {
  const checks = [check(0, 'degraded'), check(10, 'up')];
  const opts = { now: base + 20 * MIN };
  assert.equal(computeMonth(checks, '2026-09', ['app'], opts)['app'].uptime_pct, 100);
  assert.equal(computeMonth(checks, '2026-09', ['app'], { ...opts, degradedIsDown: true })['app'].uptime_pct, 50);
});

test('maintenance windows are excluded from downtime and from the measured time', () => {
  const checks = [check(0, 'down'), check(10, 'up')];
  const maintenance = [{ services: ['app'], start: at(0), end: at(10) }];
  const r = computeMonth(checks, '2026-09', ['app'], { now: base + 20 * MIN, maintenance })['app'];
  assert.equal(r.downtime_min, 0);
  assert.equal(r.uptime_pct, 100);
  assert.equal(r.elapsed_min, 10);
});

test('maintenance for another service does not apply', () => {
  const checks = [check(0, 'down'), check(10, 'up')];
  const maintenance = [{ services: ['api'], start: at(0), end: at(10) }];
  const r = computeMonth(checks, '2026-09', ['app'], { now: base + 20 * MIN, maintenance })['app'];
  assert.equal(r.downtime_min, 10);
});

test('the check made by the current run is counted', () => {
  const checks = [check(0, 'up'), check(5, 'down')];
  const r = computeMonth(checks, '2026-09', ['app'], { now: base + 5 * MIN })['app'];
  assert.equal(r.checks, 2);
  assert.equal(r.down_checks, 1);
  assert.equal(r.covered_min, 5);
});

test('checks from other months are ignored', () => {
  const checks = [{ t: '2026-08-31T23:55:00.000Z', id: 'app', s: 'down' }, check(0, 'up')];
  const r = computeMonth(checks, '2026-09', ['app'], { now: base + 10 * MIN })['app'];
  assert.equal(r.checks, 1);
  assert.equal(r.downtime_min, 0);
});

test('a service with no checks has no uptime figure', () => {
  const r = computeMonth([], '2026-09', ['app'], { now: base + 20 * MIN })['app'];
  assert.equal(r.uptime_pct, null);
  assert.equal(r.coverage_pct, 0);
});

test('incidents group consecutive failures and stay open while failing', () => {
  const checks = [
    check(0, 'up'), check(5, 'down'), check(10, 'down'), check(15, 'up'),
    check(20, 'down'),
    check(0, 'up', 'api'),
  ];
  const inc = detectIncidents(checks, { now: base + 30 * MIN });
  assert.equal(inc.length, 2);
  assert.deepEqual(inc[0], { id: 'app', start: at(20), end: null, checks: 1, duration_min: 10 });
  assert.deepEqual(inc[1], { id: 'app', start: at(5), end: at(15), checks: 2, duration_min: 10 });
});

test('incidents fully inside maintenance are dropped', () => {
  const checks = [check(0, 'down'), check(10, 'up')];
  const maintenance = [{ services: 'all', start: at(0), end: at(10) }];
  assert.equal(detectIncidents(checks, { maintenance }).length, 0);
});
