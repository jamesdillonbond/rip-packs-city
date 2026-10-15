# Handoff — 2026-10-15 monthly deep audit (run 6) + drain: what is left

Report: [audits/deep-audit-2026-10-15.md](audits/deep-audit-2026-10-15.md). Register rows R126–R132 in [audits/deep-audit-register.md](audits/deep-audit-register.md). Nothing below was applied to the DB: both `apply_migration` attempts were denied by the auto-mode classifier. Every item names its revert.

## 1. Needs a DB write (SQL editor, or explicit approval of `apply_migration`)
1. **R126 — `docs/pending-sql/audit_20261015_fmv_snapshots_touch_updated_at_and_drop_zz_probes.sql`.** Adds BEFORE UPDATE OF fmv_usd, confidence trigger bumping `fmv_snapshots.updated_at`; drops `zz_probe_20261014` / `zz_probe2_20261014`. After applying: `git mv` into `supabase/migrations/<version>_audit_20261015_...sql` (read the version from `schema_migrations`), confirm the trigger exists on a partition, run `refresh_edition_fmv_current(true)` once, expect `check_edition_fmv_current_source_drift()` = `[]`. Verify as the real caller: next haircut run, then `updated_at` moved on the haircut row. **Revert:** `DROP TRIGGER fmv_snapshots_touch_updated_at_trg ON public.fmv_snapshots; DROP FUNCTION public.fmv_snapshots_touch_updated_at();`
2. **Golazos suppression** — `docs/pending-sql/audit_20261014_golazos_sales_v1_backfill_finished_suppression_made_permanent.sql` (lapsed 10-15; `cursor_stalled` pages), then `git mv` into migrations.
3. **Delete the `topshot-misattrib-drain` suppression** (its own text: delete, do not renew; predicate failed 729 > 705).

## 2. Code (Claude Code, needs the test suite)
- **R128** `app/api/edition-floor/route.ts` `persistFloorToSnapshot`: replace the raw `fmv_snapshots` read (`select("*").in(editionIds).order(computed_at desc)` + JS `latestByEdition`) with per-edition `.limit(1)` reads in batches of ≤10, abort on any error (keep the R123 abort-before-write). Update `__tests__/api-edition-floor*.test.ts` (4 files mock the read), planted-defect check: restore the unbounded read → red. Operator-only, fails closed → P2.
- **R131** `panini-collector-walk`: stop logging ok=false when the 10-min cap is reached with the cursor advancing (log ok=true + `partial:true`), or raise the cap/shard. First read one raw `extra` and confirm the cursor advances between runs.
- **R127 (decision, not a bug):** All Day sniper defaults to `price_asc`; the Verified-FMV gate hides junk asks so first view reads "0 deals". Options: default to discount sort, or surface a "N hidden by Verified-FMV" line. Top Shot sniper also shows "0 deals" for ~30 s before the feed resolves (loading state below the fold).
- P2 hygiene: ~17 local address normalizers vs `lib/address.ts` (codemod + ratchet); ~6 bare `#E03A2F` in chart/UI components (`FmvHistoryChart`, `PinnacleFmvChart`, `ProfileHeaderPreview`, `SupportChat`, `CollectionProfileClient`); `/about`, `/legal/fmv-methodology`, `/early-access` list five collections while home says seven; unknown URLs redirect to /login rather than 404.

## 3. Trevor decisions
- **R129** the 3 `candy-opensea-*` indexers: set `OPENSEA_API_KEY` (#58) and redeploy, or mark them inactive in `pipeline_cadence_watchlist`. Silent since 10-13 ~6:05 AM PT; cron-job.org state unread.
- Optional: delete the 10 tombstoned edge functions from the dashboard (R130, refuted — harmless).

## 4. Housekeeping
- The Windows mount is ~28 commits behind origin and holds uncommitted edits (ledger +4 lines, focus.md, metrics-latest.json, sessions/2026-10.md, flow-ecosystem-watch.md, nightly-pass-git-push-setup.md). Copy those aside, then `git pull --ff-only`; delete the mount's untracked duplicate `supabase/migrations/20261014235448_*.sql` first. The 3 stranded docs and 4 inbox filings were pushed from a fresh clone (R132) — verify the mount copies match before discarding.
- R73 text is stale (concierge: 109 non-smoke rows all-time, 77 in 30 d, last 10-11 5:56 PM PT).
- Still not run: D25 `wallet_moments_cache` serial-vs-mint_count (times out), R125 backtest re-read (due 10-17), mobile/light-theme/clean-profile DOM pass.
