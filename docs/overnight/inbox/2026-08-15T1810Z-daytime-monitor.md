# Daytime monitor — 2026-08-15T~1810Z (≈11:10 PT)

Read-only sweep. Shell down (`/sessions` no-space, ~8th day) → no git clone; **inbox written to mount, push unavailable**. Artifact payload-query validation LIMITED this tick (shell down; artifact HTML lives outside the mounted repo, unreadable via file tools).

## LEAD — one genuinely NEW candidate; the rest of today's board is already logged

### 1. NEW (low risk) — two public deals views tripped `view_unexpected_definer` since the night pass reported security clean
- **Source:** `check_public_security_invariants()` → **2 rows** where the night pass logged `security 4/4 clean` at 08:11Z. Objects: `topshot_deals_vs_fmv`, `cross_collection_deals_board`.
- **Read:** both are anon+authenticated SELECT (by design — they back the public `/insights` deals surface + the concierge). Live check: `sec_invoker = null` on both (no `security_invoker=on`), which is exactly what trips the invariant. `rls_off=0`, `anon_write_holes=0`, `secdef_drift=0` — so **no leak**, this is the benign definer-mode class documented for the Candy views ("Cowork normalized them to `=on`… the invariant matches only `=on`; clears once allowlisted").
- **Likely cause:** today's very active insights/deals refactor wave (`board-page-fetch.ts`, insights board pages) recreated these two views via `CREATE OR REPLACE VIEW` without `security_invoker=on`, resetting them to definer mode. The night pass saw clean; the flags appeared during the day.
- **Suggested action (night pass / operator, LOW risk):** normalize both to `security_invoker=on` (mirroring the Candy remediation) OR add to the invariant allowlist. No data unwind — these are public boards. Verify after: `SELECT * FROM check_public_security_invariants();` → `[]`.

### 2. First-tick note (saturation symptom, root cause ALREADY logged) — cross_collection cohort_mat is 36h stale; ccm-step1 timed out
- **Source:** first-daytime-tick cross-collection verify. `cross_collection_cohort_mat` fresh = **2026-08-14 04:10Z** (~36h, > the 26h bar); `cross_collection_ts_set_overlap_mat` fresh = 2026-08-15 04:25Z (current). This is the "fresh step2 + stale step1 → step1 failed" pattern.
- **Cause:** pg_cron `rpc-ccm-step1` **failed today at 04:10Z on `canceling statement due to statement timeout`** (the cohort INSERT) — the active disk-IO saturation wave, NOT a code defect. Cohort rows 179 (stable).
- **Do NOT schedule a self-cleaning one-shot while the wave is active** — it would time out identically. Fold under the saturation umbrella already filed at `2026-08-15T1630Z` / `1200Z` / `1600Z`. Self-heals on the next quiet 04:10Z tick.

## Already logged today — NOT re-raised
- **Disk-IO saturation wave (ACTIVE at 15:35Z):** every pg_cron failure this tick is `statement timeout` / `job startup timeout` — `rpc-refresh-{allday-pack-realized,topshot-pack-sales-agg,allday-pack-sales-agg}`, `rpc-allday-ev-corrected-refresh`, `rpc-trust-health-precompute-refresh`, `rpc-pinnacle-fmv-recalc-backstop`, `rpc-ccm-step1`, `rpc-thin-sale-ask-disclosure-refresh`, `rpc-candy-wmc-ghost-purge`, `rpc-refresh-misattrib-candidates`, `rpc-backfill-pinnacle-acquisitions`, `rpc-refresh-challenge-costs`, `rpc-reconcile-saved-wallet-stats`. → `2026-08-15T1630Z` (minute-13 collision), `1200Z` (board-warm), `1700Z` (reconcile).
- **`rpc_ops_snapshot()` itself timed out** inside `sentinel_fmv_confidence_rows` — same wave; use targeted checks until it clears.
- **Trust board: 4 BREACH, all known-class** — `fmv_sweep_wedge_hours` 3.37 (→ `1600Z` fmv-recalc-killed), `panini_sale_price_capture_dry_days` 18 (known, mechanism unestablished), `public_board_slow_count` 9 (→ `1200Z`; Candy boards worst), `unmapped_resolution_backlog_max` 258 (AllDay permanent floor, do-not-raise). No new arm.
- **Stalled pipelines** (candy-listings-indexer 1233min, topshot-moments-hydrator, refresh-pack-grail-metrics-mv, allday-pack-opens-backfill, backfill-pack-rip-metadata) — the candy-listings logging defect is filed + partially shipped (`ba9ebb27` heartbeat); the rest are saturation-wave silence (runs timing out / not firing), not new stalls.

## Health summary
- Security: rls_off 0 · anon_write 0 · secdef_drift 0 · **invariants 2 (NEW, benign — item 1)**
- Trust: 4 BREACH, all known-class · DB 12,976 MB (normal growth from 12,929) · editions 27,177
- Vercel: latest READY `dpl_8huRiFs7` (761f7c9f); many CANCELED = superseded by rapid successive pushes (active session), **0 ERROR**
- Sentry: 2 new/24h, both single-event `GET /api/smoke-test` self-diagnostic "smoke check could not run" messages (9h ago) — informational, not a user-facing spike
- Cross-collection: step2 fresh, **step1/cohort_mat 36h stale (item 2, saturation)**
