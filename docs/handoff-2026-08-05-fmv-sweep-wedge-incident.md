# Handoff — the 2026-08-05 FMV sweep wedge, and the arm that could not see it

**Date:** 2026-08-05 (PT) · **For:** Claude Code / Cowork / the night pass
**Trigger:** Trevor forwarded four RPC Sentinel alerts (01:02, 02:55, 04:35, 05:15 PT). They are **one incident**, not four.

---

## 1. What happened

A DB **I/O saturation** event ran from ~04:00Z to ~13:00Z. The `fmv-recalc` catalogue sweep **wedged at cursor offset 1500** for ~9h: runs kept firing, each failed on `lock timeout` or `sales_refetch_failed` and rewrote the **same** cursor.

FMV recalc throughput, distinct editions/hour:

| 01:00 | 02:00 | 03:00 | **04:00** | 05:00 | 06:00 | 08:00 | 11:00 | **13:00** |
|---|---|---|---|---|---|---|---|---|
| 2,953 | 3,016 | 2,506 | **809** | 22 | 7 | 23 | 20 | **998 (recovering)** |

Against `pipeline_runs_daily` (the indefinite rollup — `pipeline_runs` only retains ~73h), today was a clear outlier, not noise:

| pipeline | 5-day baseline | 2026-08-05 |
|---|---|---|
| `fmv-recalc` rows written | 66k–101k/day | **13,057** (half the day gone) |
| `wallet-backfill-allday` avg duration | 35–55s | **217s** (4–6×), 55 fails vs 6–19 |
| `wallet-backfill-pinnacle` avg duration | 30–48s | **197s** (4–6×), 61 fails vs 9–21 |

Every alert is a link in one chain: saturation → `fmv-recalc` lock timeouts (`cron_silent`) → `snapshot-institutional-wallets` statement timeouts → pg_cron `job startup timeout` → `public_board_slow_count` 4→7 → a new `ufc_fmv_stale_hours` 30.4 breach (its daily sweep never landed).

**It recovered on its own.** No load-shed was applied — see §4.

---

## 2. ⚠ THE DURABLE FINDING — `fmv_sweep_stall_pct_24h` is structurally blind to this

It read **4.3 = ok through the entire incident.**

It measures the share of runs starting at `cursor_before='0'` — the 2026-08-03 *restart-at-page-0* class. **A sweep wedged at an INTERIOR offset never restarts at 0.** So the primary health board stayed green for nine hours while the alert channel was actively paging `fmv-recalc cron_silent`.

The per-collection `*_fmv_stale_hours` family is equally blind, for a different reason: other writers (`cold-tail-1.0`, `thin-sales-guard-v3`, `ask_only_v2`) keep touching `computed_at`, so freshness looks fine while the sweep is dead.

**Consequence worth internalising:** the 08:07Z overnight pass read the green board and recorded health as "green with known noise." The board and the alert channel disagreed, and the board won. **When the two disagree, the alert channel is the one with a specific claim — reconcile, don't average.**

### Shipped: `fmv_sweep_wedge_hours`

Hours since the sweep cursor last **advanced** (a successful run whose `cursor_after` differs from `cursor_before`; the end-of-catalogue wrap counts).

- **Calibrated** on the retained 72h window *including* the incident: 293 advances, gap p50 **0.20h**, p95 **0.55h**, max **6.00h**.
- **breach_at 3** — 5.5× the healthy p95.
- **Proven to bite:** replayed at 15-min ticks across 04:00–14:00Z it peaks at **5.95h** and breaches on **14 of 41** ticks (~3.5h of continuous BREACH).
- **Inline, not precomputed** — index-served, 4 buffers / ~11ms.
- Deliberately **above** the sibling `fmv-recalc cron_silent` alert (120 min), which detects *absence* of runs. This detects runs that happen and achieve nothing.
- Returns **999 if no advancing run exists** in the ~73h retention window — absence must breach, never read as health.

Board arms **34 → 35**. Backing view `v_fmv_sweep_wedge` (service_role only, `security_invoker=on`).

---

## 3. ⚠ Two root causes I asserted and then disproved — do not resurrect either

**(a) "pg_cron is starved of background workers (`max_worker_processes=6` vs `cron.max_running_jobs=32`)."** **WRONG.** `cron.use_background_workers = off` — pg_cron opens a **libpq connection per job**, so `max_worker_processes` is irrelevant and `job startup timeout` is a *connection*-establishment failure. Also every `cron.*` GUC is `postmaster` context, so `cron.max_running_jobs` **cannot be changed without a DB restart**. The proposed "lower it so pg_cron queues instead of failing" fix was wrong on mechanism *and* impossible to apply.

**(b) "Stagger the colliding pg_cron minutes."** **Theater.** The 60 startup timeouts in 24h are spread over 25 distinct jobs and track **tick frequency**, not minute collisions — the leaders are `*/2` and `*/3` jobs. Staggering buys nothing; the timeouts are a *symptom* of saturation slowing connection setup.

**(c) ⚠ "The pg_cron startup-timeout class has no instrument" — ALSO WRONG, corrected same session.** I wrote that, then checked: `get_pipeline_alerts()` **already carries a purpose-built `pgcron_startup_timeout` arm** (`prosrc` offset 7798), and it is exactly what paged Trevor at 04:35 — *"33 pg_cron tick(s) failed with 'job startup timeout' in the last 30 min across 14 job(s). The function body never ran, so nothing was logged to pipeline_runs and the cron_silent/stalled checks cannot see this."* The arm even documents its own rationale.

**What is actually true:** `detect_stalled_pipelines()` and anything reading `pipeline_runs` are blind to this class — but that blindness is *already covered* by a dedicated alert arm that fired correctly. **Nothing to build.** I asserted the gap before checking for existing coverage; measured cost of the arm I was about to add was 760ms / 5,539 buffers, which would also have been too expensive to run inline.

---

## 4. Why no load was shed

The wallet-backfill fleet was the obvious candidate and it is **not** the cause: run counts were **down** (allday 273 vs a ~550 baseline) while duration was up 4–6×. It is a victim of the saturation, not its source. By the time the diagnosis was complete the sweep was already recovering (13:00Z back to 998 eds/h), so disabling the redundant GHA backstop would have removed a safety net to fix a problem that was resolving.

⚠ Noted in passing: the GHA backstop drifts badly off its `38 2,8,14,20` schedule — observed fires at 05:32Z, 11:03Z, 16:29Z, 21:52Z. Same GHA schedule-drift class already documented for `allow-list-reconcile`. Not acted on.

**The actual source of the I/O was not isolated.** `pg_stat_statements` is cumulative since reset and could not be windowed to 04:00Z. If this recurs, that is the gap to close first.

---

## 5. Still open

- **`v_fmv_thin_sale_ask_disclosure` is fixed for the CRON but STILL batch-only.** Restructured this session: **could not finish in 600s → `succeeded` in 58s, 239 rows**, fingerprint matching the 08-04 baseline on every dimension. Refresher is back on cron (**jobid 256, `25 9 * * *`, `cron_heavy`**). But the `s90` aggregate alone is **19.7s / 28,125 disk reads** and that is irreducible by query shape: **no `sales` partition carries an unconditional `sold_at`-leading index — all are partial.** So do **not** read this as "now safe for a page." The remaining lever is an index (`(sold_at DESC) INCLUDE (edition_id, collection_id, price_usd) WHERE price_usd > 0.10 AND edition_id IS NOT NULL`), deliberately **not** taken — a plain `CREATE INDEX` takes ACCESS EXCLUSIVE on a hot ingest partition, and `CONCURRENTLY` cannot run inside `apply_migration`. Do it in an idle window with a `lock_timeout`.
- **The disclosure UI itself is still unbuilt.** The cache table is populated and fresh; the moment-page copy spec is in the Cowork handoff §1 (four binding rules — never a range, show the real last-sale date however old, suppress from ranked boards entirely, singular/plural). A consumer MUST check `refreshed_at` and degrade rather than render stale asks as current.
- ~~The pg_cron `job startup timeout` invisibility class~~ — **NOT open, already covered by `get_pipeline_alerts()`; see §3(c).**
- **Isolating the I/O source** (§4).
- **`wallet-username-resolver` — the 08-05 overnight QUEUE, independently re-measured and CONFIRMED, now at 40% failure (was 33.9%).** ⚠ **And one tempting fix is now foreclosed.**
  - Per-branch measurement the overnight pass did not have: **ONE of the four candidate branches costs 21.5s** on its own (Index Only Scan on `idx_sales_2026_pulse_window`, 67,776 index entries, **21,136 heap fetches**, 16,842 blocks read from disk) to produce **2,033 distinct addresses**. Four branches ≈ 85s — matching their end-to-end 81.9s / 85.3s exactly. The function's own `statement_timeout` is 60s, so it legitimately cannot finish.
  - ⚠ **DO NOT "just narrow the 21-day window."** It looks like free money and it is not: the window is **load-bearing for the retry path**. The predicate re-attempts an address whose `last_attempted_at` is older than **14 days**, and to be re-attempted it must still be inside the candidate window — so a 21d window is what supports a 14d retry cycle. Measured live: `wallet_usernames` holds 8,153 rows, 1,153 unresolved, **1,099 inside the negative cache and 54 retry-due**. Narrowing to a few days silently strands the retry cohort.
  - So the overnight pass's conclusion stands: **Option A (cut the cron-job.org cadence from ~20 min to hourly/2-hourly) is the right lever and it is operator-only.** Option B is a genuine redesign — split into a cheap frequent pass (new addresses) plus a rare full pass (retries) — not a one-line window change.
  - Impact is contention, not data: it holds a pooled connection for 60s+ every 20 minutes to return ~4 rows, feeding the exact saturation class in §1. Failures are non-destructive (the address is left for the next tick) and the payload is a display nicety (@handle vs `0x…`).
- Everything carried in `handoff-2026-08-05-consolidated.md` §5 **except** the Candy flip — see below.

### ⚠ Correction to the Cowork handoff §5

It lists *"Candy flip — one-liner, `CANDY_MLB_PUBLIC = true`"* as open. **It is not.** [lib/launch-flags.ts:43](../lib/launch-flags.ts#L43) already reads `export const CANDY_MLB_PUBLIC = true` — it shipped **2026-07-31** and the board has been public since. Do not "flip" it again.

---

## Guardrails confirmed this session

- ⚠ `cron.use_background_workers = off` here; all `cron.*` GUCs are `postmaster` context (restart-only).
- ⚠ Heavy cron jobs run as **`cron_heavy`** (600s) and need EXECUTE granted to it. `service_role` caps at **30s**, `postgres` at **120s**.
- ⚠ A function's `statement_timeout` **cannot extend the timer already armed for its caller** — raise it in the cron *command string*.
- ⚠ `CREATE OR REPLACE VIEW` drops `reloptions` — always re-set `security_invoker = on`.
- ✅ The guarded `DO`-block anchored replace against `pg_get_viewdef` (RAISE on missing anchor / already-present / no-change) is the **proven safe way** to edit the 38 KB `v_rpc_trust_health` without round-tripping it. Used by Cowork's Panini arm and by `fmv_sweep_wedge_hours`.
- ✅ Recovering MCP-applied migrations: transcribe, then **md5-verify against `supabase_migrations.schema_migrations`**. All 5 recovered this session matched.
