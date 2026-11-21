# Overnight pass — 2026-11-21 (Cowork cloud, laptop-VM clone + .rpc-git-cred push)

**Run:** genuine overnight. Clock verified vs DB — shell/VM `date -u` 09:02:10Z, DB `now()` 09:02:24Z, newest `sales.ingested_at` 08:56Z, newest `fmv_snapshots.computed_at` 08:54Z; no skew. Real local time **~01:02 AM PT**, inside the 00:00–06:00 window. Not frozen. Push AVAILABLE (laptop-VM `.rpc-git-cred`, `push --dry-run` exit 0; `ls-remote` = clone HEAD `d987774ff`). Lock was RELEASED (prior `cowork-20261120T090325Z-9893`); taken over as `cowork-20261121T090254Z-12413`, released at end.

**Verdict: GREEN. Shipped 0.** Nothing was both safe and not-already-done. Every inbox candidate was already resolved by the 11-20 afternoon/evening Claude Code passes; the three live trust breaches are all benign consequences of the deliberate Candy phantom cleanup; the post-ship watch of the last 24–48h ships is clean (no regression, no revert).

---

## Stranded-output sweep
CLEAN. `git hash-object` of the mounted `docs/overnight/ledger.md` and `docs/overnight/flow-ecosystem-watch.md` both equal `origin/main`; no mount-only `docs/handoff-*.md` or `docs/health/*`. Nothing to carry over. Inbox files identical on origin and mount (the daytime monitor's pushes all landed).

## Reviewed
- **Inbox drained.** Two files newer than the 11-20 pass:
  - `2026-11-21T0315Z` (Claude Code → Cowork): all 3 items **already CLOSED** — item 1 zero-yield suppression retire (`20261121044524`), item 2 Candy market-daily phantom window nulled (`20261121043220`, 16,471 rows), item 3 four phantom Candy bids retired (`20261121073043`). Nothing to do.
  - `2026-11-20T1911Z` (daytime monitor): CANDIDATE 1 AllDay-EV dup-key **already RESOLVED** (`20261120191551`, trigger re-keys pack_ev_history); CANDIDATE 2 "no READY deploy on HEAD" info-only (docs/db-only CANCELED tips). Verified healed below.
  - Older inbox files all drained by prior passes.
- **Focus steer (top, 11-20 11:15 PM PT):** `candy_ask_book_drop_pct` breach is the deliberate phantom-ask retirement; do NOT raise/exclude/ack; self-clears by ~7:35 PM PT 11-21. Honored.

## Health-drift (rpc_ops_snapshot @ 09:04Z)
- **Security: CLEAN** — invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`; also function_search_path_drift, procedure_txn_control_pins, backward_cursor_rewinds, procedure_search_path_unpinned, suppression_parked_claim_drift, suppression_count_predicate_drift all `[]`.
- **Trust health: 3 breaches, all benign Candy-cleanup side-effects (NOT failures):**
  1. `candy_ask_book_drop_pct` 93.7 (breach 60) — the 9,426 phantom-ask retirement, per the focus steer. Falsifier read tonight (benign vs new collapse): active asks **642**, all `owner_moved_at` NULL (above the ~600 new-collapse floor); retired-tonight rows **9,530**, newest last_seen 06:35Z (not re-seen since). Benign. The 8 PM PT 11-21 daytime falsifier is still owed.
  2. `candy_offers_oldest_active_hours` 999 and 3. `candy_offers_unverified_pct` 999 (breach 36 / 25) — **NEW tonight.** Cause: the 4 phantom Candy bids were retired (`20261121073043`), leaving **0 active offers** (confirmed: `candy_offers` 0 active of 2,170; newest active = null). The arm's own inline doc: *"Returns 999 when there are zero active offers, so a vanished book BREACHES rather than dividing to a comfortable zero"* — working as designed, loudly flagging an empty book. The emptiness is correct (there are no real Candy bids; the only 4 were phantom, from a 0.00089-SOL drained wallet). Left untouched — NOT acked/excluded/suppressed, same rule as the ask-book arm. Self-clears when a real Candy bid appears. See QUEUED below.
  - `candy_revival_sales_since_recorded_silence` now **0/ok** (last pass had it at 429.83/breach; the dust aged below the $250 floor — no wording decision outstanding).
- **Stalled pipelines:** `[]`.
- **Sentinel:** ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0. Sentry dark since 08-18 (#34).
- **pipeline_fails_24h:** all designed base-rate classes — topshot-pack-supply-atlas 41 (Atlas 404/403 Cloudflare challenge on per-minute cadence, ~2.6%, nothing lost), refresh_wmc_fmv_changed 3, atlas-pack-market 3, atlas-pack-sales-ingest 3, others 1–2. `pipeline_alerts` 4 rows, all `info` (Atlas market-feed 403 / pack-pull moved-moment 400 / pack-supply 404 / pack-book 403) — all freshness-current, none escalated.
- **Client-error beacon:** `usage_events.client_error` 0 in 24h / 0 in 6h.
- **DB size:** 58,374 MB (was 57,936 on 11-20; +438 MB, normal growth, decelerating from the +2,485 the night before).

## Post-ship regression watch (last ~24–48h ships) — CLEAN
- **`20261120191551` AllDay-EV dup-key trigger fix — HEALED.** pg_cron jobid 65 (`rpc-allday-ev-corrected-refresh`): 18:47Z 11-20 FAILED (duplicate key, the pre-fix condition), then **00:47Z (73.9s) and 06:47Z (61.7s) 11-21 both SUCCEEDED**. MV un-frozen; `pack_ev_board_max_stale_days` ok (0.025). No further action.
- **`9b0d13420`/ff383f0 apply-fmv-haircut HEAVY_LAST — HEALED.** 11-20 22:35Z (2:35 PM PT) run ok=true, `legs_skipped=0`, all 7 legs ran (heavy legs nba_top_shot 16.9s and nfl_all_day 20.5s ran LAST, succeeded), 50.6s total vs the 151.3s / 3-skipped pre-fix run. Falsifier met.
- **Vercel:** newest READY production = `e0848a0c5` ("emails: deal-alert suggestion"), rollback candidate; the 6 newest tips are all CANCELED docs/db-only commits (expected via `ignoreCommand`), 0 ERROR. CANDIDATE 2 from the 11-20T1911Z inbox is this known, zero-impact state.

## Shipped
None.

## Queued — needs your decision
- **`candy_offers` trust arms (`candy_offers_oldest_active_hours`, `candy_offers_unverified_pct`) read BREACH (sentinel 999) because the Candy offers book is empty** after retiring the 4 phantom bids (`20261121073043`). The arm is working as designed (a vanished book breaches loudly rather than dividing to a comfortable zero), and the emptiness is the correct state. It will self-clear the moment a real Candy bid is observed. No code change was shipped — an arm that distinguishes "deliberately-emptied / genuinely no bids" from "upstream failure emptied the book" would be a route-logic change to a trust instrument (not autonomous-eligible), and the focus rule forbids acking/excluding these Candy-cleanup breaches. **Decision:** leave as-is (recommended — it self-clears and correctly reports no verified offers), or, if Candy bids are expected to stay absent for a while and you'd rather an empty book read UNKNOWN than BREACH, that's a one-line arm change to queue. Night 1.

## Failed / blocked / reverted
None. No shipping attempted; no hard-stop.

## Continuity
- Ledger: one READ entry appended (this pass).
- `metrics-latest.json`: overwritten with tonight's vector.
- Session entry prepended to `docs/sessions/2026-11.md`.
- Lock released.
