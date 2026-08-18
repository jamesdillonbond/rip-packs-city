# Candidate — systemic hourly heavy-cron pileup in the :13–:34 band is manufacturing IO-saturation spells

**Filed by:** rpc-daytime-monitor · 2026-08-18 ~03:40Z (20:40 PT) · priority: HIGH
**Context:** filed during an active disk-IO saturation spell (5→37 IO-wait sessions at its :19–:25 peak; `rpc_ops_snapshot()` and even indexed `count(*)`s timed out; ~11 pg_cron jobs failing as collateral).

## The real finding (bigger than one job)
`cron.job` shows **eight hourly (`*`-hour) heavy jobs packed into a 21-minute band every hour**:
`:13` jobid 71 `backfill-historical-pack-ev` · `:14` 72 `allday-rollup-rip-value` · `:17` 26 `allday-resolve-rip-dist-api` · `:19` 218 `backfill-pinnacle-mint-acquisitions` · `:24` 75 `sync-allday-pack-dist-totals` · `:25` 217 `atlas-pack-ev` · `:29` 261 `refresh-unmapped-backlog-growth` · `:34` 216 `raise-edition-offers-backstop` — plus several `*/6`/`*/2` jobs sprinkled through the same minutes.
When several coincide they **mutually amplify**: a job that runs 11–18s alone balloons to 600s and fails. The spell is partly self-inflicted by scheduling, not just organic load.

⚠ **jobid 71 (`:13`, hourly) is the known pack-EV hog** — focus.md Item 1 / `compute_pack_ev_per_edition_weighted`, ~100 min/week of `cron_heavy` for ~0 rows, pinned+measured. It leads the pileup every hour. Its real fix is the `fmv_current` lateral-accessor migration already queued; until then it is the single biggest amplifier in this band.

## Evidence the pinnacle backfill (218) is victim + amplifier, not intrinsically heavy
Last 8 runs of jobid 218: **11s, 18s, 53s, 104s, 104s, 152s, and 2 FAILED at 600s.** Uncontended it is cheap (11–18s); it only balloons/fails when it lands in a spell — where it does **zero** backfill work *and* holds IO, deepening the spell. It is an incremental catch-up backfill (`pinnacle_mint_events ⋈ wmc` anti-join `moment_acquisitions`, `LIMIT 50000`, insert-new-only) on a small, slow-moving collection — **hourly is overkill**. (Backlog count could not be measured — the anti-join times out under the very saturation it contributes to; measure it in a quiet window.)

## ⛔ Capability limit discovered this run
**pg_cron reschedule cannot be done from the Supabase MCP connection.** `current_user` = `postgres` (NOT superuser); job 218 is owned by `cron_heavy`. `cron.alter_job` → *"does not exist or you don't own it"*; `SET ROLE cron_heavy` succeeds but then `cron.alter_job` → *"permission denied for function alter_job"*. So any reschedule must go through **(a) the Supabase dashboard → Database → Cron (Trevor)**, or **(b) a migration run in the elevated context (night pass / Claude Code)**.

## Ready-to-execute fix (reversible; do in a quiet window, NOT mid-spell)
1. **Cut 218 frequency** hourly → every 3h: schedule `19 * * * *` → `19 */3 * * *`. Removes 16 of its 24 daily collision chances. Safe for freshness (pinnacle mints are slow; LIMIT 50000/run ≫ mint rate). Revert: back to `19 * * * *`.
2. **De-pile the band:** move the remaining hourly heavy jobs off :13–:34 into empty minutes (e.g. 75→:48, 217→:53, 261→:05, 216→:58) so no two heavy jobs overlap. Pure timing change — no frequency/data impact. Reversible per job.
3. **Land the jobid 71 pack-EV lateral-accessor migration** (focus.md Item 1) — the durable win; measure in a quiet window first.

Migration form (elevated context): `SELECT cron.alter_job(218, schedule => '19 */3 * * *');` etc.
Dashboard form: edit each job's schedule in Database → Cron.

**Still open:** exact 218 backlog count (quiet-window measure); whether the `*/6` and `*/2` jobs in the band also want nudging; `refresh_pack_grail_metrics_mv` is API-triggered (not cron) and lands in-window opportunistically — check its caller.

---

# ⚠ RE-MEASURED 2026-08-17 21:00 PT (Claude Code, interactive) — headline REFUTED, fix #1 SHIPPED

Measured in a **quiet window** (3 IO-wait / 4 active sessions, vs the 37 at the spell peak), which is what the filing itself asked for. Re-derived rather than trusted — three of the four claims below reverse.

## ⛔ REFUTED — "the band manufactures the spells"

The `:13`–`:34` band is **constant**: the same jobs sit at the same minutes every hour. Yet jobid 218's concurrent overlap over 48 h ranges **1 → 28**, and it tracks 218's **own runtime** almost linearly:

| 218 runtime | overlapping cron runs |
|---:|---:|
| 11 s | 1 |
| 18 s | 2 |
| 104 s | 3 |
| 272 s | 12 |
| 450 s | 19 |
| 601 s (failed) | 28 |

A constant cause cannot produce a 1→28 swing. **The pileup is a CONSEQUENCE of long runtimes, not their cause** — same result the 2026-08-16 jobid-71 measurement produced, where a filed `:13` stagger was measured to make things *strictly worse*.

⛔ **Fix #2 (de-pile the band) is therefore NOT SHIPPED and should not be re-filed.** It also has nowhere to go: the proposed "empty minutes" are occupied — **:48** is next to jobid 232/248 at :47, **:53** next to 219/36 at :52, **:05** holds jobid 76 (`cron_heavy`), **:58** holds jobids 29/16/55/83/56. Start-minute staggering is dead on this instance; the lever is the work.

## ⛔ REFUTED — "218 is uncontended cheap (11–18 s), a victim"

That came from an **8-run tail**. Over 7 days: **157 succeeded avg 116.8 s / max 480.1 s**, plus **11 failed avg 558.9 s / max 966.3 s** — roughly **5.4 h/week** of `cron_heavy`. Not cheap, and not merely a victim.

## ✅ THE ACTUAL MECHANISM — the `LIMIT 50000` never binds

`EXPLAIN` on the candidates query gives a **Merge Anti Join** streaming ~247k `pinnacle_mint_events` against ~877k `moment_acquisitions` (rows=**1** estimate), then a nested-loop probe into `wallet_moments_cache` per survivor. Only **tens** of candidates exist, so the LIMIT is never satisfied and **every run walks the whole join to completion.** This is a **full sweep wearing an incremental catch-up's clothes**; the 11 s ↔ 966 s spread is just cache-vs-disk. Corroboration that the cost is intrinsic: the same anti-join **failed to complete inside a 90 s budget in the quiet window**.

## ✅ ANSWERED — the open "backlog count" item

Still not countable (the anti-join times out even quiet — which is itself the finding). Measured from the **outcome table** instead, per the `rows_written`-is-a-null-instrument rule: `moment_acquisitions WHERE source='pinnacle_mints'` gained **92 rows on 08-17, 275 on 08-16, 102 on 08-15, 67 on 08-14**; 6,372 all-time against 420,139 mint events. So: **tens of rows/day across 24 runs, against a 50,000/run ceiling.**

## ✅ SHIPPED — fix #1 only

jobid **218** `19 * * * *` → **`19 */3 * * *`**, applied + verified live (jobid still 218, one row, owner still `cron_heavy` so the 600 s budget survives). Removes 16 of 24 daily full sweeps. Safe: 8 runs/day × 50,000 ceiling ≫ ~10²/day arrivals; nothing keys on acquisition-history freshness; and the sibling `rpc-backfill-pinnacle-acquisitions` (jobid 78), same class of work on the same collection, **already runs `17 */6`** — hourly was the outlier. Record: `supabase/migrations/20260818040426_audit_20260817_pinnacle_mint_acquisitions_cadence_cut.sql`.

⚠ **NOT the durable fix.** The durable fix is to make the LIMIT *bind* — a watermark or an index-supported "unprocessed" predicate on the anti-join. Until then this is 8 full sweeps/day instead of 24. Do not read the cadence cut as closing it.

## ⛔ CAPABILITY CLAIM IS FALSE (second filing of this dead end)

"pg_cron reschedule cannot be done from the Supabase MCP connection" is **wrong**. The pincer is real for `cron.alter_job` only. `cron.schedule` under `SET LOCAL ROLE cron_heavy` works, updates **in place** (same jobid), and preserves the role's 600 s budget. It needed no dashboard and no night pass. ⚠ Never `cron.unschedule` first — that churns the jobid (109 → 332, 2026-08-16).

## Untouched

Fix #3 (the jobid 71 pack-EV lateral-accessor migration, focus.md Item 1) is still the durable win and is **still correctly unshipped** — it needs its pin file repointed. Nothing here changes its standing. `refresh_pack_grail_metrics_mv`'s caller remains unchecked.
