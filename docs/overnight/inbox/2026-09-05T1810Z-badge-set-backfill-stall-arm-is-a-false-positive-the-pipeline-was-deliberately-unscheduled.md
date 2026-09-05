# `topshot-badge-set-backfill`'s cadence-stall arm is a false positive — the pipeline was **deliberately unscheduled 2026-09-04**, but its stall arm was seeded the same day and now trips

*rpc-daytime-monitor · 11:06 PT / 18:06Z 2026-09-05 · READ-ONLY sweep, nothing shipped · inbox written to mount, push unavailable (harvested remote has no credentials — cloud env, expected)*

## What tripped

`rpc_ops_snapshot().stalled_pipelines` (and `detect_stalled_pipelines()`) list **`topshot-badge-set-backfill`**: silent **1251 min** against its `max_silent_minutes = 1083` (~18 h), `severity info`, `classification no_marker`. Last run 2026-09-04 21:15:39Z; every run 09-03→09-04 was `ok=false / 0 rows`, then it stopped firing entirely.

## Why it is a false positive (not new work, not a regression)

The pipeline was **intentionally retired on 09-04** and is documented as such:

- **Suppressed** in `pipeline_alert_suppression` (`added_at 2026-08-30`, `expires_at 2026-09-13`): *"dead host 2026-08-30: public-api.nbatopshot.com 530/1033 … Schedules paused."*
- **Unscheduled** per inbox `2026-09-04T0220Z` §1 RESOLVED ("Do not re-file it"): its GHA `badge-sync.yml` schedule was stopped because **the Atlas walk covers 266/266 sets and keeps 13,891/13,915 badge rows fresh within 6 h** (the one gap, set 152 *2023-24 Honors (Diced)*, returns `total_count=0` from Atlas — this route could not serve it either). Route kept, schedule removed.

So it is silent **because it was deliberately turned off**. The `pipeline_alert_suppression` row silences the *failure_rate/alert* path (`get_pipeline_alerts`), but the **cadence-stall arm is a separate mechanism** (`pipeline_cadence_watchlist` → `detect_stalled_pipelines`) that the suppression does not cover — so the stall keeps surfacing on every sweep. This is exactly the "a permanently-red instrument is indistinguishable from a broken one" anti-pattern CLAUDE.md warns about.

## The seed context (why this happened, and the three siblings to watch)

All four of these Top Shot arms were seeded together on **2026-09-04 04:44:17Z** (migration `20260904044417`), all `is_active=true`, all `info`:

| pipeline | max_silent_minutes | status now |
|---|---|---|
| `topshot-badge-set-backfill` | **1083 (~18 h)** | unscheduled 09-04 → **silent → arm trips** |
| `topshot-catalog-backfill` | 4323 (~72 h) | unscheduled 09-04 (Atlas covers) — still logs failing ticks via its own route, so not yet silent |
| `topshot-misattrib-drain` | 4323 | dead (one-off script, per 0220Z) — still ticks/530s |
| `ingest-topshot-challenges` | 4323 | dead (was zero-yield) — still ticks/530s |

Only badge-set trips today because its 18 h threshold is short enough and it is the one that actually stopped *firing*. The other three still fire-and-fail every 6 h, so their (72 h) silent arms have not tripped — but they are arms watching pipelines already decided-dead, and will dangle the moment those schedules are removed too.

## Suggested action (night pass — LOW risk, config-row only)

Deactivate the stall arm for the deliberately-retired pipeline:

```sql
-- verify it is the intended row first
SELECT pipeline, is_active, max_silent_minutes FROM pipeline_cadence_watchlist
WHERE pipeline = 'topshot-badge-set-backfill';   -- expect is_active=true, 1083

UPDATE pipeline_cadence_watchlist
SET is_active = false
WHERE pipeline = 'topshot-badge-set-backfill';
```

**Predicate that makes this correct:** the pipeline has no live scheduler (no pg_cron/GHA/vercel.json job dispatches it since 09-04 21:15Z) AND its coverage is inherited by the Atlas walk (13,891/13,915 badge rows fresh ≤6 h). **If either becomes false** — i.e. badge-set is ever rescheduled, or Atlas badge freshness lapses — re-activating the arm is the right move, so this is a deactivate-because-retired, not a suppress-a-real-signal.

**Revert:** `UPDATE pipeline_cadence_watchlist SET is_active = true WHERE pipeline = 'topshot-badge-set-backfill';`

**Optional companion (not required):** when `topshot-catalog-backfill` / `topshot-misattrib-drain` / `ingest-topshot-challenges` are fully unscheduled, deactivate their arms the same way — or, better, make the seeding/suppression mechanisms aware of each other so unscheduling a pipeline retires its cadence arm in the same migration. Left as a note, not filed as an action.

## ✅ PREDICATE VERIFIED — 2026-09-05 20:05Z, Claude Code (Trevor's box)

**Not my filing.** Committed on its author's behalf (it could not push) and then its predicate was **re-derived rather than inherited**, so the night pass can act without re-doing this. **Both clauses hold — the suggested `UPDATE` is safe.**

| clause | filed | verified |
|---|---|---|
| watchlist row | `is_active=true`, `max_silent_minutes=1083` | ✅ exactly |
| last run | 2026-09-04 21:15:39Z | ✅ exactly |
| alert suppression present | expires 2026-09-13 | ✅ exactly |
| **no live scheduler** | asserted | ✅ **GHA: none · `vercel.json` crons: none · `pg_cron`: 0** |
| **coverage inherited** | 13,891/13,915 fresh ≤6 h | ✅ **18,139 / 19,740 fresh ≤6 h (91.9%)**, 98.8% ≤24 h, newest **20:05Z** (minutes old) |

⚠ **The population grew** (19,740 rows vs the filed 13,915), so quote the new numbers, not the old ones. The *property* — badges are being kept fresh by something other than this pipeline — holds strongly.

### 🚨 One supporting sentence in this filing is WRONG, and it is the one that would stop a careful reader

> *"its GHA `badge-sync.yml` schedule was stopped"*

**`badge-sync.yml` is still scheduled (`cron: "15 */6 * * *"`) and ran FOUR times today** — 10:37, 12:02, 15:16 and 16:55Z, all `schedule`, all `success`. I hit this and briefly believed the predicate was false.

⭐ **It resolves in favour of the filing, via the route names:**

- `badge-sync.yml` calls **`/api/badge-sync`**, which logs pipeline **`topshot-badge-catalog`** (`route.ts:160`);
- the pipeline in question, **`topshot-badge-set-backfill`**, is logged by a **different route** — `app/api/admin/backfill-badges-from-sets/route.ts:52` — and **nothing calls that one** (GHA/`vercel.json`/pg_cron all zero).

👉 **So the CONCLUSION is right and only that sentence is wrong.** ⚠ Two similarly-named pipelines (`topshot-badge-catalog` vs `topshot-badge-set-backfill`) behind two different routes, one live and one retired, is exactly the shape this repo's *"name the caller, never infer it from the name"* rule exists for. **Verify by the route that writes `p_pipeline`, not by the workflow filename.**

## Everything else this sweep saw was healthy or already filed (not re-raised)

- Security invariants / anon-write-holes / RLS-off base tables / SECDEF-anon: all `[]` (clean).
- `check_pgcron_recent_failures()`: `[]`.
- Trust health: 2 BREACH, both known — `unmapped_resolution_backlog_max` 132 (declining 172→148→132, worker-side, owned) and `public_board_slow_count` 1 (`topshot_2025_rookie_cohort_stats` under contention, focus §7, deliberately not retuned).
- `allday-pack-opens-backfill` 56.6% failure: **already filed** (ledger — window artifact of the 09-04 jobid-55 unschedule, self-clears ~22:00 PT 09-05). Not re-filed.
- `atlas-editions-upstream-403` (28/480, 5.8%): attributed to the Atlas Cloudflare challenge, no rows lost, self-retrying — do-not-investigate (memory-pinned).
- Vercel: last-6h deploys are READY + CANCELED (CANCELED = Trevor's rapid co-working pushes superseding in-flight builds), **zero ERROR**.
- Artifact validation: `rpc-live-health` (merged primary dashboard) payload objects all resolve, freshness 0 h. `pack_reality_top_ev`=0 is the known #50 dead-host drain. Remaining artifacts not individually re-run this tick — no schema-breaking migration landed today (today's DDL was suppression inserts + a search_path ALTER + a liveness function, none touching view/column names).
