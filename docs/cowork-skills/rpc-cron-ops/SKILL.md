---
name: rpc-cron-ops
description: "Rip Packs City cron operations — load when scheduling, moving, debugging, or automating cron-job.org entries or GitHub Actions schedules for RPC. Triggers on \"cron job\", \"cron-job.org\", \"schedule a job\", \"stagger\", \"change the frequency\", \"the cron is failing\", \"next execution\", or driving the cron-job.org console in Chrome. Encodes the auth gotchas, the stagger discipline, the 30s-cap rule, and the hard-won console automation recipe."
---

# RPC cron operations

Trigger surfaces: cron-job.org (~70 entries, free tier, 30s hard client timeout) + GitHub Actions schedules + 3 worker-target entries. **The verified schedule reference is `docs/operations/cron-schedule.md`** — if it disagrees with the dashboard, the dashboard wins and the doc must be updated.

## 🚨 Secret safety — READ THIS BEFORE OPENING ANY JOB PAGE

⛔ **The old rule in this file was WRONG, and the token leaked twice while it was being obeyed (register #32 — this text is the corrected copy; the repo source `docs/cowork-skills/rpc-cron-ops/SKILL.md` is kept identical to it, and whichever is newer wins).** It said the auth header lives behind the ADVANCED tab and that staying on COMMON was safe.

⭐ **Measured 2026-09-13: the `Authorization` / `Bearer` value is a plain text input ON THE COMMON TAB**, a few fields below the crontab expression. `Content-Type` sits beside it. **Tab discipline protects nothing.** What leaks a token is the READ, not the tab.

**The actual rule — on ANY job page, never do a broad read:**

- ⛔ No `get_page_text`, no full `read_page`, no screenshot that includes the header fields.
- ⛔ No unscoped `querySelectorAll('input')` — that is exactly how a ~48-character prefix reached a transcript.
- ✅ Use `find` for one named field, or JS that returns **only structural facts** — e.g. map inputs to `/^(Authorization|Content-Type|X-)/`-matching KEY NAMES and never their values; read a `<select>`'s chosen verb, not the form.
- ✅ **To create an entry, CLONE an existing healthy one** (`Actions → Clone`). The clone carries the header without anyone reading it. Pick a source on the same host with the same method and the same token, then change only title / URL / schedule. Proven 2026-09-13 creating `RPC Pipeline Sentinel` — no token read at any point.
- ⚠ `get_edge_function` and `cron.job.command` ALSO hand back live gate keys. Redact or hash; never echo.

## Scheduling discipline (post-stagger, 2026-06-07)

- NEVER schedule on minutes 0, 1, 20, 21, 40, 41 — the old anchor pile-up (~15 jobs at :00) caused the connection-pool saturation failure class. Pick an empty comma-trio from the schedule doc for anything new.
- cron-job.org grids reject range-step syntax (`1-59/6`); the crontab expression field accepts `*/N`. Use explicit comma lists otherwise.
- GHA `*/20` always anchors :00/:20/:40 — GHA schedules need explicit offset lists too.
- ⭐ **Tick the "notify me when the cronjob will be disabled because of too many failures" checkbox on EVERY entry.** It was off on all nine entries the 2026-09-10 Vercel spend-cap pause auto-disabled; they ran dead for two days and the one event that turns a recoverable outage into a permanent one notified nobody. A clone inherits it — verify anyway.
- Throughput lever for queue-draining pipelines is CRON FREQUENCY, not batch size (pack-EV lesson).

## The 30 s client cap (CRON-30S)

- Routes that can exceed 30s MUST return 202 + `after()` or cron-job.org marks every run failed and may AUTO-DISABLE the entry.
- ⛔ **`maxDuration` does NOT protect you.** A route at `maxDuration = 300` still dies at the caller's 30 s. The two limits are unrelated.
- 🚨 **A run killed at the client cap never reaches its own `log_pipeline_run`, so `pipeline_runs` reads 100% healthy PRECISELY BECAUSE the failures are absent** — and the recorded max duration is the max *below* the censoring point. Derived independently twice (2026-09-13). **Never conclude a lane is healthy from its own completions table; cross-read the console's run history.**
- ⚠ **Adding a second caller can break an invariant the route states.** `/api/sentinel` documents that invocations never overlap, which is what makes its module-level clock sufficient; the moment a cron-job.org lane joined the GHA one, a delayed GHA tick overlapped it by 50.8 s (2026-09-13). GitHub's median scheduled delay is ~45 min, so with lanes 30 min apart collision is the EXPECTED case. Check for shared module state before adding a caller.
- When a route runs in ack mode, have it write its OWN heartbeat tagged distinctly (`event: "cron-ack"`, never `"schedule"`) — a fire-and-forget caller has no runner to write one, and `rpc_gha_schedule_watchdog()` counts only `schedule`, so a healthy cron-job.org lane tagged wrongly would mask a total GHA stall.

## Auth gotchas

- A cron "Successful 200" can actually be the LOGIN PAGE: proxy.ts 307s unauthenticated calls to /login and cron-job.org follows it. Tells: `X-Matched-Path: /login`, text/html, byte-identical Content-Length across runs. Always verify the API path on test runs.
- Use `www.rippackscity.com` — the apex 308 redirect strips the Authorization header cross-host.
- Auth goes in the `Authorization: Bearer <INGEST_SECRET_TOKEN>` header field, never `?token=` in the URL (leaks into dashboard/history).
- Self-fetches inside routes ALSO need the Bearer header or they get the login page (the Pipeline Sentinel was red for days on exactly this).

## Console automation recipe (Chrome)

The console (console.cron-job.org, React/MUI) **SILENTLY IGNORES synthetic edits.** This is the single most expensive property of this surface: 8 of 9 saves were discarded on 2026-09-12 while every per-field re-read reported success.

- ⚠ **`form_input` no-ops on the URL field** — it reports the OLD value as both `previous` and `new` and nothing changes (measured 2026-09-13). Same class as the crontab field. **Type into the focused field instead:** triple-click → `ctrl+a` → `Delete` → `type`.
- For the crontab input specifically, the proven path is JS-focus → `select()` → `document.execCommand('insertText', false, '<expr>')` (fires real input events so the minutes `<select>` GRID syncs — **the grid is what saves**) → verify `[...minutesSelect.selectedOptions]` → JS `.click()` Save. Clicking a minute in the grid directly also works and updates the crontab preview.
- ⚠ **`Test run` opens a confirmation dialog.** A ref-based click does not open it; a coordinate click does. Then click `START TEST RUN`. The result panel shows status, duration and response headers — a clean positive control that the header carried (a 401 looks identical from the DB side).
- ⚠ **A clone is created DISABLED** ("Please enable the job to start executions"). Enable it before saving, or it silently never runs.
- ✅ **Verify persistence on the jobs LIST page** — server truth. Per-job field re-reads show client-only state. Async edit scripts die mid-await at the next navigation and every field read still reports success; only the LIST page knows.
- Job edit URLs are `console.cron-job.org/jobs/<id>`; harvest ids from anchor hrefs on the list page (`find` for the row's EDIT button works when a JS href sweep returns nothing).
- ⚠ Coordinates and find-refs are both unreliable across SPA re-renders — refs expire on navigation, clicks land on BODY. Re-screenshot after any navigation before clicking by coordinate.
- ⭐ **A QUERY STRING ADDED BY EDITING AN EXISTING JOB'S URL DOES NOT PERSIST** (measured 3× on 2026-09-19: keyboard type, `insertText`, and a real SAVE click each said `Cronjob saved successfully.` and the server read back the URL without `?ack=1`). A query string typed into a CLONE at creation persists (`RPC Pipeline Sentinel`, `RPC Stale FMV Monitor` 8474496). **When a URL gains a `?…`: clone → type the full URL → save → delete the old job; never edit in place.** Read the URL back from a fresh navigation to the job page — the LIST page renders URLs without their query string.
- Proven positive control for a new entry: open its `/history`, click the first executed row's `DETAILS` (a coordinate click — a ref click did not open it), and read ONLY the response-header lines `X-Matched-Path` / `Content-Type` and the body's first JSON keys. `X-Matched-Path: /api/…` is the API; `/login` is the proxy's 307. Never read request headers.
- `Actions → Delete` opens a normal MUI dialog whose DELETE button clicks fine via JS; a coordinate click on the menu item can leave the tab's screenshot capture hanging for 30 s — the page is fine, use JS to read/act until the next navigation.
- 🚨 A `javascript_tool` result is BLOCKED (`Cookie/query string data`) if it returns any URL carrying a query string — the edge-function entries' URLs carry `?key=` gate keys, so a list-page sweep must strip everything from `?` on before returning, or return titles/status only. That block is the secret guard working; do not route around it.
- ✅ **Health-sweep recipe that passes the guard (2026-09-19):** on `/jobs`, map each `table tbody tr` to `title | last execution | next execution` using ONLY `innerText` lines containing no `http`, no `?`, no `supabase`, no `rippackscity`, and strip `https?://\S+` / `\?\S*` from the other cells; flag `Failed` in the last-execution cell and `Inactive` in the next-execution cell. Baseline 2026-09-19 8:45 PM PT: **88 entries, 17 inactive, all deliberate** (listed by reason in `docs/operations/cron-schedule.md`) — an 18th inactive row is an auto-disable to investigate. A lane healthy at 7–11 s on its history page that fails only inside an IO spell is estate-bound, not a console problem.

## When a cron-fired pipeline fails intermittently

Check the SLOT before the code (rush-window contention was the root cause of nearly every "flaky pipeline" in May–June 2026). Then check the 30s cap (route >30s = failed-on-dashboard while succeeding server-side). Watchlist a rescheduled pipeline only after its first ok=true at the new slot.

⚠ **Inactive ≠ broken.** All 17 inactive entries (of 88, 2026-09-19) are deliberate and listed by reason in the schedule doc. Identify a real outage by a `Failed (HTTP error)` cluster on a date, never by inactivity.

⚠ **The jobs LIST shows only the last run; `/jobs/<id>/history` holds ~50 executions with durations (measured 2026-09-19: 53 rows, 50 executed, 4.5 h of a 5-minute lane).** A "it has failed every run" claim must come from the history page and state its window; the list page has a sample size of 1.