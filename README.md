# teramot-status

Status page for Teramot's services: **https://status.teramot.com**

Plain HTML and JS, no build step. [`.github/workflows/status.yml`](./.github/workflows/status.yml)
runs every 5 minutes: `scripts/check.mjs` probes every service in
`site/services.json`, stores the results on the `status-data` branch and
deploys `site/` to GitHub Pages. The page is also the record the monthly SLA
is measured against.

```
site/
  index.html         the page
  services.json      monitored services
  sla.json           SLA parameters (target, what counts as down)
  maintenance.json   maintenance windows (excluded from the SLA)
  incidents.json     incidents, written by hand
  data/              written by scripts/check.mjs (gitignored; lives on the status-data branch)
    checks/YYYY-MM.ndjson   every check, one line each: {t, id, s, ms, code, err?}
    history.json            per-day check counts, last 90 days (the bars)
    sla.json                monthly uptime per service
    detected-incidents.json outages detected from the checks
    status.json             latest result per service
scripts/
  check.mjs          probes the services and writes data/
  sla.mjs            SLA math (pure functions)
  sla.test.mjs       tests: node --test scripts/sla.test.mjs
```

## How the SLA is measured

- A check stands for the service's state from its own time until the next
  check, capped at 15 minutes. Past the cap the time is **uncovered** (the
  monitor didn't run, so nobody knows) and counts as neither up nor down.
- **Downtime** runs from the first failed check to the first healthy one.
- **Monthly uptime** = `1 − downtime / covered time`, per UTC calendar month.
- **Coverage** = covered time / elapsed time in the month. Read it next to the
  uptime: 100% at 40% coverage says little.
- Windows in `maintenance.json` are subtracted from everything.
- *Degraded* (slower than 3s) counts as available unless
  `degraded_counts_as_down: true` in `site/sla.json`.
- The current and previous months are recomputed on every run; older months
  stay as last computed in `data/sla.json`. Raw checks are never deleted.
- If the workflow can't read `status-data` it fails instead of starting over:
  an empty history would overwrite the SLA record.

## Common tasks

- **Add or remove a service:** edit `site/services.json`. HTTP 2xx is always
  required. On top of that:
  - `"expect": { "json": { "data.status": "ok" } }` requires a field of a JSON
    body (dot path) to equal a value;
  - `"expect": { "contains": ["<div id=\"root\""] }` requires each string to
    appear in the body.

  A failed expectation counts as **down**: the service answered, but it isn't
  healthy (or isn't the service at all).
- **Schedule maintenance:** add to `site/maintenance.json`
  `{ "services": ["docs"] | "all", "start": ISO, "end": ISO, "title", "body" }`.
  It shows on the page until it ends and is excluded from the SLA. Announce it
  before it starts: a window added after the fact rewrites the current and
  previous months.
- **Post an incident:** add to `site/incidents.json` (the text is shown to
  users, so write it in Spanish):
  ```json
  { "title": "Demoras en consultas", "date": "2026-09-25T14:00:00-03:00",
    "body": "Estamos investigando…", "resolved": false }
  ```
  A push to `main` deploys right away.

## Local

```sh
node scripts/check.mjs            # writes site/data/
node --test scripts/sla.test.mjs
cd site && python3 -m http.server 8000
```

## Notes

- GitHub's cron is not exact: runs can be 5–15 minutes late or skipped, which
  shows up as lost coverage.
- On public repos GitHub disables scheduled workflows after 60 days without
  repository activity. If that happens, re-enable it from the Actions tab.
