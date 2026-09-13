---
name: rpc-cron-ops
description: Rip Packs City cron operations — load when scheduling, moving, debugging, or automating cron-job.org entries or GitHub Actions schedules for RPC. Triggers on "cron job", "cron-job.org", "schedule a job", "stagger", "change the frequency", "the cron is failing", "next execution", or driving the cron-job.org console in Chrome. Encodes the auth gotchas, the stagger discipline, the 30s-cap rule, and the hard-won console automation recipe.
---

# RPC cron operations

Trigger surfaces: cron-job.org (~69 entries, free tier, 30s hard client timeout) + GitHub Actions schedules + 3 worker-target entries. **The verified schedule reference is `docs/operations/cron-schedule.md`** — regenerated from the live dashboard 2026-06-07; if it disagrees with the dashboard, the dashboard wins and the doc must be updated.

## Scheduling discipline (post-stagger, 2026-06-07)

- NEVER schedule on minutes 0, 1, 20, 21, 40, 41 — the old anchor pile-up (~15 jobs at :00) caused the connection-pool saturation failure class (statement timeouts at rush windows). Everything was deliberately staggered; pick an empty comma-trio from the schedule doc for anything new.
- cron-job.org grids reject range-step syntax (`1-59/6`); the crontab expression field accepts `*/N`. Use explicit comma lists otherwise.
- GHA `*/20` always anchors :00/:20/:40 — GHA schedules need explicit offset lists too.
- Routes that can exceed 30s MUST return 202 + `after()` (the CRON-30S pattern) or cron-job.org marks every run failed and may AUTO-DISABLE the entry (silent-kill class). The 202 also makes high-frequency scheduling safe.
- Throughput lever for queue-draining pipelines is CRON FREQUENCY, not batch size (pack-EV lesson).

## Auth gotchas

- A cron "Successful 200" can actually be the LOGIN PAGE: proxy.ts 307s unauthenticated calls to /login and cron-job.org follows it. Tells: `X-Matched-Path: /login`, text/html, byte-identical Content-Length across runs. Always verify the API path on test runs.
- Use `www.rippackscity.com` — the apex 308 redirect strips the Authorization header cross-host.
- Auth goes in the `Authorization: Bearer <INGEST_SECRET_TOKEN>` header field, never `?token=` in the URL (leaks into dashboard/history; the 2026-06-07 hygiene pass removed all of them).
- Self-fetches inside routes (e.g. the sentinel checking another API) ALSO need the Bearer header or they get the login page (the Pipeline Sentinel was red for days on exactly this).

## Console automation recipe (Chrome) — hard-won 2026-06-07

- **HARD RULE (Trevor): stay on each job's COMMON tab only — NEVER open the ADVANCED tab.** Everything needed for schedule edits lives on Common.
- ⛔ **CORRECTION 2026-09-12: THE REASON THIS RULE USED TO GIVE IS FALSE, AND BELIEVING IT CAUSED A SECOND LEAK.** It said Advanced “holds auth-header secrets”, which reads as *Common does not*. **It does.** The `Authorization` / `Bearer …` pair is a rendered, readable text input **on the Common tab**, a few fields below the crontab expression. **Staying on Common protects nothing by itself** — the rule below is the one doing the work, and it is not a supplement to this one, it is the whole of it.
- **HARD RULE (secret-safety, 2026-06-19): not opening Advanced is NOT enough — the Authorization header lives in the page DOM regardless of which tab is rendered.** NEVER broad-query the edit page: no `querySelectorAll('input')`, no full `read_page` / `get_page_text` / DOM dump, no "read all the fields." Scope every DOM read to exactly the two controls schedule edits need: the crontab `<input>` and the 60-option minutes `<select>`. Use the find tool for a single element. Never echo Bearer/token/key/secret values. 🚨 **IT HAS NOW HAPPENED TWICE — 2026-06-19 and 2026-09-12, same token, same mechanism, with this rule already written down both times.** The second time the query was `querySelectorAll('input[type=text]')` mapped over `.value`, self-justified as *narrower than `input`* — **it is not narrower in the way that matters: the header value IS a text input.** ⭐ **The rule is not “avoid `input`”; it is “never read `.value` off this page at all.”** Read `type`, `checked`, `disabled`, label text and element COUNTS; never values. The only exception is the crontab expression field, and only to verify an expression you wrote yourself a moment earlier.
- 🚨 **AND THE SECOND LEAK'S ROOT CAUSE IS #32, NOT INATTENTION: the INSTALLED export of this skill is the pre-2026-06-19 copy and DOES NOT CONTAIN THE RULE ABOVE** (4,232 bytes against this file's larger current size). A session loading the installed skill is handed the false premise and none of the correction — which is exactly what happened. **Until #32 is closed, apply THIS FILE, not the loaded skill, wherever they disagree.**
- The console (console.cron-job.org, React/MUI) SILENTLY IGNORES synthetic edits: JS value-setters, ref-clicked typing, and CDP keystrokes can all render perfect client state (field, grid, preview) while Save POSTs the OLD schedule — no toast, no network request is the tell (`read_network_requests` filtered to api.cron-job.org: a real save fires a POST).
- ⚠ **THE BROWSER TOOL RETURNS AN UN-AWAITED PROMISE AS `{}`, so an `async` edit script is FIRE-AND-FORGET and the next `navigate` in the same batch kills it mid-await.** Measured 2026-09-12: **8 of 9 “saves” did nothing**, and a per-job field re-read would have reported every one of them as applied. **Synchronous scripts only, one action per call, an explicit `wait` after every navigate — and the LIST page after every write.**
- ⭐ **TO CREATE AN ENTRY THAT NEEDS THE AUTH HEADER, USE `Actions → Clone` ON AN EXISTING ENTRY, then edit the clone's title / URL / schedule on Common.** The clone carries the header across without it ever being read, typed, or rendered into a tool result. **Never hand-create an authed entry** — that needs the value, which is the one thing that must not be handled.
- ⭐ **TURN ON “Notify me when the cronjob will be disabled because of too many failures” ON EVERY ENTRY.** It was off on the nine entries auto-disabled 2026-09-10, which is why a recoverable Vercel budget pause became a two-day outage nobody could see (#76). **It is the single event that turns a transient failure into a permanent one.**
- The ONLY reliable write path: JS-focus the crontab input → `select()` → `document.execCommand('insertText', false, '<expr>')` (fires real input events → the minutes `<select>` GRID syncs — the grid is what saves) → verify `[...minutesSelect.selectedOptions]` matches the target → JS `.click()` the Save button → confirm a POST fired.
- Verify persistence on the jobs LIST page ("next execution" column = server truth); per-job field re-reads can show client-only state. Coordinates and find-refs are unreliable (clicks land on BODY after SPA re-renders; refs expire on navigation).
- Job edit URLs are `console.cron-job.org/jobs/<id>`; harvest ids from anchor hrefs on the list page.

## When a cron-fired pipeline fails intermittently

Check the SLOT before the code (rush-window contention was the root cause of nearly every "flaky pipeline" in May-June 2026). Then check the 30s cap (route >30s = failed-on-dashboard while succeeding server-side — look at `pipeline_runs`, not the dashboard). Watchlist a rescheduled pipeline only after its first ok=true at the new slot.
