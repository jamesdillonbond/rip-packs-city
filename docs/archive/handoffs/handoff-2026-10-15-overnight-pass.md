# RPC overnight pass — 2026-10-15

⚠ **Scope:** this cloud session pushed through the **device-VM clone + `.rpc-git-cred`** path (the cloud sandbox proxy strips auth headers, so it cannot push directly). Trevor's machine and Claude Code push normally via Git Credential Manager — **commit as usual.** This is a fact about this environment, not the artifacts.

**Pass:** overnight nightly, cloud, run `40bf407e`. Real time **2026-10-15 ~01:15 AM PT** (DB `now()` == VM clock, no skew). Lock taken then released.

**Verdict:** 🟢 **GREEN · 0 shipped** · idle: **routed-to-trevor** (every open item is Trevor / SQL-editor / operator-gated, and the whole app tree is hot from the 10-14 Claude Code audit — collision gate = queue-only for code) · **oldest routed: #58 OPENSEA_API_KEY ~20 nights (Trevor-shelved 09-23).**

Nothing was clearly-safe + net-positive to ship. A quiet, honest, healthy night. Nothing was fabricated to look busy.

## Queued for Trevor / Claude Code
1. **[P-med, Trevor, ~20 nights] #58 `OPENSEA_API_KEY`** — the `candy-opensea` listings/sales indexers fail every tick on `OPENSEA_API_KEY not set`. Shelved 09-23 (no spend); lanes parked 10-13. The `failure_rate` HIGH rows age out of the 3-day window on their own. Only a Trevor env-var sets it. Off-limits for a night pass (secret).
2. **[P-med, SQL editor, carried] Golazos backfill false-positive HIGH** — `golazos_sales_v1_backfill` `cursor_stalled` 14d is a *finished* backfill. The suppression that makes the alert permanent is committed at `docs/pending-sql/audit_20261014_golazos_sales_v1_backfill_finished_suppression_made_permanent.sql`; `apply_migration` is MCP-held (data write, confirmation this headless session cannot give — timed out 3× on 10-14). **Run it in the dashboard SQL editor.** No user-facing impact; ops-alert noise only.
3. **[operator-gated, Trevor] `drop_scratch` residue** — `flowty_archive.scratch_*` (~185 MB, Trevor's data). Drop SQL at `scripts/flow-wallet-walk/drop_scratch.sql`; MCP-held, SQL-editor-only. Drop only on Trevor's word.
4. **[P-low, operator since 08-22] #23 / #25 edge-fn drift** — edge functions not running `main`; needs the operator deploy path, not autonomy.
5. **[P-low, SQL editor] `topshot-misattrib-drain` suppression delete** — the suppression drift (observed 705 > 500) is draining on its own (877 → 705, <500 in ~2d). Deleting the suppression is a #101 datapoint, not urgent.
6. **[cosmetic, SQL editor] `zz_probe_20261014()` + 10-14 Market probe/fn residue** — `function_search_path_drift` reports `zz_probe_20261014()` (SECURITY INVOKER, advisory only). It and the two `select 1` probes + unused `get_market_team_options` / AD v1 are on the 10-14 residue drop list. SQL-editor DROP (MCP-held).

## Health sweep — 2026-10-15 ~01:15 AM PT
- **Security:** clean — `check_public_security_invariants` [], `check_anon_write_surface` [], `check_secdef_anon_execute_violations` [], `rls_off_base_tables` [].
- **Trust health:** **0 breaches** (all 38 arms `ok`). `candy_sales_stale_hours` 76.8 is `ok` (breach_at retuned 30→168 on 10-14). Magic Eden's Candy feed silence is **upstream** and Trevor-aware. `trust_precompute_max_age` 5.35h.
- **Pipelines:** `detect_stalled_pipelines` []; `check_when_others_timeout_blind` 0; `check_zero_yield_lanes` 0 offenders (332 inspected, 6 suppressed — the fn returns ONE jsonb row, `offenders[]` is empty).
- **pipeline_alerts (all known / parked / attributed):** candy-opensea ×2 = #58; golazos backfill = queue item 2; `panini-collector-walk` 32% = 10-min per-walk cap (by design); Atlas editions/market/supply/pack 403 + flow-rest-moment-moved + pack-pull 400 all **INFO** (attributed by request_id, nothing lost, last 200s current).
- **Sentry:** dark (quota off 08-18, SDK removed #34). Client health from Vercel + E2E DOM smoke beacon.
- **Vercel:** tip `99b60a0e5` deploy `dpl_3hiEUYmWvmM9hSpwRZFTgAdscQRH` **READY**. 16 runtime-error groups, all **chronic low-count bounded-read timeouts** (pack-detail reads, market-cap tile, insights boards; many first-seen 08-23). **One NEW transient:** `/api/sniper-feed` "badge_editions @page 8: Project not specified" ×1 at 07:04Z — pre-existing code (route last touched 10-09, **not** a 10-14 regression). Watch for recurrence.
- **db size:** 37,952 MB (+735 vs 10-14 5:30 PM).
- **Accuracy (the gate):** TS published ALL ratio **1.000**, err 14.1%, HIGH 83.1% within 25%; All Day published ALL ratio **1.000**, err 20.0%, HIGH 12.5% err. No drift past 1.10/0.90 on the ALL buckets (known tiny worst buckets: AD STALE n=10 ratio 3.0, ASK_ONLY n=61 ratio 1.62).

## Post-ship watch — 10-14 (heavy Claude Code audit day) — all GREEN
- `rpc-market-edition-badges-topshot` / `-allday` jobs both **succeeded** (07:21Z / 07:25Z).
- `rpc-thp-leg-panini-fmv-share` **succeeded** 03:57Z; value **23.8%** (shipped at 23.7%).
- Search-catalog migrations `20261015042434` / `052846` live via tip. The `299b6a90a` **CANCELED** deploy is an ancestor of the tip — a superseded rapid-push build, **not** a dropped commit; its code is live.
- FMV-alert transition fix: `fmv_alerts` holds 0 rows, so nothing live changed. Deploy READY.
- **No regression** attributable to any 10-14 ship.

## Reviewed, no action
Inbox drained (newest filing 2026-10-12, ✅ fixed — nothing new from the daytime monitor since). Ready-queue carried items folded into the queue above. No Cowork artifacts flagged broken/stale. Focus-file steers reviewed (all current do-not-reflag classes held).

## Shipped / Failed / Reverted
None / none / none.
