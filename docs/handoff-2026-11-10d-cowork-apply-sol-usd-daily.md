# Handoff → Cowork: apply `sol_usd_daily` + re-verify the Candy marketplace silence (2026-11-10, Claude Code cloud)

**Why Cowork (part A only):** Claude Code's `apply_migration` raised the Supabase confirmation prompt twice (2:35 and ~2:50 PM PT
11-10) and it never reached Trevor; Trevor: "Do it. If it's something you can't do here, hand it off to cowork."
Use the **dashboard SQL editor in Trevor's Chrome** (the 11-08 / 11-09 route). Nothing below is in production yet.

**What it fixes (Sentinel WARN 11-10 2:04 PM PT, trust arm `candy_sales_stale_hours` breach_at 0):** 2,528 Candy sales
sit in `candy_sales_unresolved` with `skip_reason = 'no_sol_rate'` (sold 08-16 → 11-09, 667.7 SOL). The indexer
prices a past-day sale from CoinGecko's SOL/USD history, and that call FAILS from Vercel's egress (`sol_days_primed = 0`
on every drain; 300 retried, 0 resolved, every 3 h). The same CoinGecko range call from the database (pg_net) answers 200
with the exact 00:00 UTC points the indexer's basis uses. This migration stores them in `public.sol_usd_daily`.

**The app half is already live** (`lib/chains/solana/das.ts` `primeSolUsdFromTable`, wired into both Candy sales
indexers; deploys from `main`). Until the table exists it fails soft: `sol_db_error` in the run's `extra` names the
missing relation and pricing falls back to CoinGecko exactly as before.

| File (fetch from `main`) | SHA-256 |
|---|---|
| `docs/proposals/audit_20261110_sol_usd_daily_from_db_egress-STAGED.sql` | `1ab2006ac742c1b50cc2789272ebcc399e552176634853e15b4c0fc425ef0b92` |

## 1. Pre-check (stop if any line differs)

```sql
SELECT to_regclass('public.sol_usd_daily')                          AS tbl,   -- NULL
       (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-sol-usd-daily') AS job;  -- 0
```

## 2. Apply

1. Fetch the file from `main`, check its SHA-256 against the table above, paste the WHOLE file and Run. A
   "Potential issue detected" dialog is expected (REVOKEs, `cron.schedule`): confirm it.
2. Record it, with the UTC time you ran it as the version (14 digits, `YYYYMMDDHHMMSS`):

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<VERSION>', 'audit_20261110_sol_usd_daily_from_db_egress');
```

3. Fill the table now rather than waiting for the 6-hourly tick (two calls, ~10 s apart: the first dispatches the
   CoinGecko request, the second collects it):

```sql
SELECT public.sol_usd_daily_tick();   -- {"dispatched": <id>, ...}
-- wait ~10 s
SELECT public.sol_usd_daily_tick();   -- {"collected": 1, "days_written": ~99, ...}
```

## 3. Post-check (expected values in comments)

```sql
SELECT (SELECT count(*) FROM public.sol_usd_daily)                    AS days,        -- ~99
       (SELECT min(day) FROM public.sol_usd_daily)                    AS oldest,      -- ~100 days back (≤ 2026-08-16)
       (SELECT max(day) FROM public.sol_usd_daily)                    AS newest,      -- yesterday (UTC)
       (SELECT usd FROM public.sol_usd_daily WHERE day = '2026-08-16') AS aug16,      -- 75.2798…
       (SELECT relrowsecurity FROM pg_class WHERE relname = 'sol_usd_daily') AS rls,  -- true
       has_table_privilege('anon', 'public.sol_usd_daily', 'SELECT')   AS anon_read,  -- false
       has_function_privilege('anon', 'public.sol_usd_daily_tick()', 'EXECUTE') AS anon_exec, -- false
       (SELECT schedule FROM cron.job WHERE jobname = 'rpc-sol-usd-daily') AS cron;   -- 41 */6 * * *
```

## 4. Repo half

```bash
git pull --ff-only origin main
git mv docs/proposals/audit_20261110_sol_usd_daily_from_db_egress-STAGED.sql \
       supabase/migrations/<VERSION>_audit_20261110_sol_usd_daily_from_db_egress.sql
```

Then a ledger entry (date · what shipped · revert path below), commit the ledger first, then the migration move, push.

## 5. Watch

- The next `candy-sales-indexer` run (every 3 h at :20): `extra.sol_days_primed_db` > 0, `sol_db_error` null,
  `drain_resolved` > 0, `unresolved_open` falling from 2,578 (~300 a run; ~1 day to drain, other skip reasons stay).
- The trust arm `candy_sales_stale_hours` leaves breach once fewer than 50 sales parked in 48 h remain unresolved.
- `sol-usd-daily` pipeline rows every 6 h, ok, `days_written` 0–1 once caught up.

## Revert

```sql
SELECT cron.unschedule('rpc-sol-usd-daily');
DROP FUNCTION public.sol_usd_daily_tick();
DROP TABLE public.sol_usd_daily_requests;
DROP TABLE public.sol_usd_daily;
```
The app half then reports `sol_db_error` and prices from CoinGecko only, as before.

---

# Part B — ✅ DONE by Claude Code 11-10 ~2:55 PM PT (`20261110225146`; arm now 0). Nothing for Cowork here.

<details><summary>original runbook (kept for the record)</summary>

# Part B — re-verify the Candy marketplace silence (trust arm `candy_revival_sales_since_recorded_silence` = 1)

**Why:** the arm fired on one Magic Eden sale of **$0.17 on 11-09**; with it, 4 dust sales (11-07 ×3, 11-08; 0.034 SOL,
~$3) sit parked `no_sol_rate`. Five sales / ~$3 in four weeks is a trickle, not a revived market. The arm's own text asks
for this change: re-look at Candy trading and update the `candy_mlb` row of `v_collection_marketplace_status`. That
row is a literal inside the view, so it is a `CREATE OR REPLACE VIEW`. Only the three `candy_mlb` literals change
(`silent_since_2026_11_10`, `last_verified_at` 2026-11-10 22:55 UTC, a dated note); the rest is the live definition
verbatim, guarded by its md5 (`cb6fa6c9…`, reconstructed and matched locally); `security_invoker` is kept.
Tested on a scratch Postgres (stub tables): Candy reads `silent_since_2026_11_10`, Panini unchanged, `security_invoker=true`.

| File (fetch from `main`) | SHA-256 |
|---|---|
| `docs/proposals/audit_20261110_candy_marketplace_silence_reverified-STAGED.sql` | `66e201e710cbf9b6cabf5d7a76fd1e67653cda3c6dc113aa5e95692fbb961403` |

1. Paste the whole file, Run. If the DO block raises "drifted", stop — another session changed the view; file it back.
2. Record: `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('<VERSION_B>', 'audit_20261110_candy_marketplace_silence_reverified');`
3. Post-check:
```sql
SELECT secondary_status, last_verified_at FROM v_collection_marketplace_status WHERE slug = 'candy_mlb';  -- silent_since_2026_11_10 | 2026-11-10 22:55+00
SELECT reloptions FROM pg_class WHERE relname = 'v_collection_marketplace_status';                       -- {security_invoker=true}
SELECT metric, value, status FROM v_rpc_trust_health WHERE metric = 'candy_revival_sales_since_recorded_silence';  -- 0, OK
```
4. Repo: `git mv docs/proposals/audit_20261110_candy_marketplace_silence_reverified-STAGED.sql supabase/migrations/<VERSION_B>_audit_20261110_candy_marketplace_silence_reverified.sql`; ledger entry; commit; push.

</details>

# Part C — no action: `candy_ask_book_drop_pct` 91.2 is a false positive and clears itself ~7:35 PM PT 11-10

The 11-09 7:35 PM PT `candy-listings-indexer` pass ingested 228 Magic Eden asks and, in the same run, deactivated 208 whose
seller no longer owns the card (`owner_moved_cards: 208`, ghost listings). Every pass since finds the same **20** valid
asks on a complete sweep. The arm divides active asks by asks "seen in the last 24 h", and those 208 carry a 7:35 PM PT
`last_seen_at`, so they age out of its window at ~7:35 PM PT tonight. Optional follow-up for a later session: exclude
rows with `owner_moved_at` set in the same pass from the denominator (they were never valid asks).
