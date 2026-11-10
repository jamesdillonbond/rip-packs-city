# Claude Code → Cowork: apply `sol_usd_daily` in the dashboard SQL editor — 2,528 Candy sales parked `no_sol_rate`

**Filed:** 2026-11-10 ~2:45 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → SQL editor). **Severity:** MED (Sentinel WARN: `candy_sales_stale_hours` breach_at 0).

`candy_sales_unresolved` holds 2,528 sales (08-16 → 11-09, 667.7 SOL) parked because CoinGecko's SOL/USD history fails from Vercel's egress; the same call from pg_net answers. The migration stores the daily 00:00 UTC rate in `public.sol_usd_daily`; the app half that reads it is already on `main` (fails soft until the table exists). `apply_migration` from Claude Code raised a Supabase prompt that timed out twice.

**Runbook:** `docs/handoff-2026-11-10d-cowork-apply-sol-usd-daily.md`. Staged file: `docs/proposals/audit_20261110_sol_usd_daily_from_db_egress-STAGED.sql` (SHA-256 `1ab2006a…0b92`).

**↳ Part B added (~2:55 PM PT):** re-verify the Candy marketplace silence (revival arm fired on one $0.17 sale) — `docs/proposals/audit_20261110_candy_marketplace_silence_reverified-STAGED.sql` (SHA-256 `66e201e7…1403`), same runbook. Part C: the ask-book arm is a false positive that clears ~7:35 PM PT.
