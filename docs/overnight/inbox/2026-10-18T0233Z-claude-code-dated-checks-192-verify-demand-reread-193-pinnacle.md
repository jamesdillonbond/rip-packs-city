# 🟡 Claude Code (10-17 ~7:45 PM PT, docs-refresh thread, archived) — three DATE-GATED checks for the night pass: verify #192, the 10-22 demand re-read, the ~10-31 #193 re-measure

**Status:** OPEN · three items, each with its own date gate. Before an item's date, skip it silently. Filed here because a fresh-session scheduled task from a Claude Code cloud session carries no connectors (`connectors` is org-gated; tooling-gotchas.md, "fresh-session Routine … stores NO MCP connectors"), and the thread that owned these is archived. The same three are summarised as a 10-17 ~7:40 PM PT STEER in `focus.md`.

## 1 · DUE the 10-18 overnight pass — verify #192 (`allday-buyer-backfill`)

**What shipped:** `24a2ca565` (deployed ~6:25 PM PT 10-17, `dpl_8rLGJ5qkQKxQUbKiR31KXELZaZiH`). The window floor is mainnet27's root, `CURRENT_SPORK_START_ISO = 2025-10-22` (`lib/pipeline/buyer-backfill-window.ts`). A non-empty batch that decodes nothing, or a failed `sales` UPDATE, now fails the run (`extra.update_failed`). Before the fix, every run from 10-16 decoded 0 of 480 at `ok=true`, with the cursor walking down to 2025-10-06.

**Read:**
```sql
select to_char(started_at at time zone 'America/Los_Angeles','MM-DD HH24:MI') pt, pipeline, ok, rows_found, rows_written, error,
       extra->>'wrapped' wrapped, extra->>'cursor_sold_at' cur, extra->>'decode_failed' df, extra->>'update_failed' uf
from pipeline_runs where pipeline in ('allday-buyer-backfill','golazos-buyer-backfill')
  and started_at > '2026-10-18 01:30+00' order by started_at;
```
**Verdict:**
- PASS: the first post-deploy All Day run wraps (`wrapped = true`, short batch, because the cursor is below the floor). Later runs either resolve buyers (`rows_written > 0`) or fail honestly with "decode wall".
- FAIL: rows at or above 2025-10-22 still decode 0 of N. That is a decode bug, not the spork boundary.

**Write:** add a ↳ line under item 192 in `known-issues.md` (do not touch its first sentence) and under the 10-17 "Documentation refresh" ledger entry, then update the "Verify #192" Now item in `docs/strategy/collections/nfl-all-day.md`.

## 2 · DUE on/after 10-22 — demand re-read, PT week 10-15..10-21

**Method:** use the method of the `roadmap-status.md` block "⭐ NEW 2026-10-15 — DEMAND READ, WEEK OF 10-08..10-14 PT":
- `usage_events` minus `metadata.automated` and the unflagged headless fingerprint;
- external signed-in users minus `internal_accounts`;
- first-page sources;
- the funnel: wallet paste → share view → sign-in click, plus email capture;
- the 10-14 surfaces' counts.

**Report against:** Google one-page share 19/26; paste → sign-in click 10 → 0. Write a new dated block above the 10-15 one, and update `roadmap-2026-10-17.md` §2 and `features/insights-and-seo.md`.

## 3 · DUE on/after 10-31 — re-measure #193 (Pinnacle HIGH vs a median of the last 5 sales)

**Method:** as written in the item. Sales since 2026-10-11 07:00 UTC are scored against the `pinnacle_fmv_history` value in force ≥ 1 day before the sale, and against the median of the render's last 5 sales ≥ 1 day before it. Report within ±25 % and WAPE by confidence.

**Gate:** ≥ 500 HIGH sales.

⛔ **A pricing-engine change is not a night-pass ship.** Record the numbers in #193 and the handoff. If last-5 still wins on HIGH on both measures without costing MEDIUM, queue the `pinnacle_fmv_recalc_render` change for an interactive session (migration file, pin and drift guard, live-`prosrc` re-read). If the gap has closed, close #193 as falsified.
