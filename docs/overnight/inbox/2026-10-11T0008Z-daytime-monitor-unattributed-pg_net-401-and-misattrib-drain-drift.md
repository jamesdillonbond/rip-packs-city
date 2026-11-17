# Daytime monitor — 2026-10-11T00:08Z (~5:08 PM PT 10-10)

Read-only daytime sweep. Platform HEALTHY (security 4/4 clean, trust 38/38 ok, stalled [], pg_cron [], latest prod deploy READY). Heavy active-build day: 12 production deploys in ~1h, all READY (incl. #181 chain-arrival refloor, candy OpenSea sales/offers/listings feeds, panini premiums board, board-cache fresh-window fix, offers-backfill Flow 429 retry). NOT in a saturation spell (snapshot + all probes returned fast), so causes below are stated at normal confidence, not deferred.

Candidates (all low-risk; sensing only):

## 1. Unattributed pg_net HTTP 401 — 7 in 3h, empty body [P-low]
- **Source:** `rpc_ops_snapshot().pipeline_alerts` → `pg_net_http_401` (critical-by-classification); `net._http_response` status 401, 7 rows 22:53Z→00:05Z, empty bodies.
- **Attribution done this pass:** joined request_id to `atlas_edition_requests`, `topshot_atlas_market_requests`, `topshot_moment_hydrate_requests`, `topshot_atlas_pack_requests`, `member_wallet_username_requests` → **0 of 7 matched**. Steady low rate (~2/h), not a burst.
- **Risk read:** low. No pipeline stalled, no freshness breach, nothing lost on any attributed lane. The classification is "critical" only because the arm cannot tell an edge-function misconfig (stale ?key= gate / rotated secret) from a self-inflicted DB probe when it can't attribute. 401 (not 403/400) + empty body = an auth rejection, which points at a gate-keyed endpoint rather than a Cloudflare challenge.
- **Suggested action (night pass):** join the 7 ids to the FULL set of `*_request*` tables (incl. `atlas_supply_requests`, candy/OpenSea dispatch tables — the candy OpenSea sales/offers/listings indexers shipped TODAY and are a plausible new 401 source if any dispatch via pg_net) before calling it unknown; then check whether the owning endpoint has a stale ?key= gate / rotated secret (cf. carried #144 ATLAS_POOL_INGEST_KEY rotation). If it resolves to a self-inflicted probe, record its request id so the row clears. Do not alarm Trevor — no user-facing impact.

## 2. suppression_count_predicate_drift: topshot-misattrib-drain 1544 open vs 500 threshold [P-low]
- **Source:** `rpc_ops_snapshot().suppression_count_predicate_drift` (the #102 arm shipped 2026-10-10 ~12:10 PM PT, `20261010185858`). Predicate: "open misattribution candidates (no on-chain map row) <= 500" — observed 1544 (~3x).
- **Risk read:** low. This is the arm's FIRST daytime reading after the #101 Atlas misattribution resolver + daily remap shipped 10-10 ~11:32 AM PT (`20261010182920`/`…183112`) — the daily remap has not necessarily completed a full cycle yet, so 1544 may be the pre-drain backlog rather than a stuck queue.
- **Suggested action (night pass):** confirm the #101 resolver is actually DRAINING this pool (is the open count falling day-over-day?), not a no-op like the pre-10-10 resolver. If it is draining, the predicate threshold may simply need to track the new steady-state floor (Trevor's call); if it is NOT draining, that is the real finding. Re-measure before concluding.

## 3. allday-storefront-reconcile failure_rate medium — 6/21 over 3 days (28.6%) [P-low, likely chronic]
- **Source:** `rpc_ops_snapshot().pipeline_alerts` → `allday-storefront-reconcile`, "1 storefront walk(s) failed", medium.
- **Risk read:** low. 3-day pooled rate at medium with single-walk failures; not in ledger/Declined, not flagged new by the 10-08/10-09 night passes — most likely chronic transient-walk noise. Flagged only because it is not yet dispositioned anywhere.
- **Suggested action (night pass):** quick-glance whether any single-walk failure carries a real error vs a transient upstream hiccup; if chronic/benign, add a one-line do-not-reflag disposition so future passes skip it.

## Context (NOT candidates — so the night pass doesn't mistake them for regressions)
- **pg_net 400 ("failed to convert event payload for block 1b655af8…") and 404 ("block at height 100000000") are almost certainly the NEW #181 chain-arrival refloor/bisect probes shipped TODAY** (`run_chain_arrival_refloor`, pg_cron every 10 min on mainnet27; "bisect from 130,290,700 on live"). Bisecting against a live Flow REST node naturally queries non-existent heights (404) and hits occasional un-decodable blocks (400). Self-inflicted, by-design — matches the focus pattern for height-probe 400/404s. Re-open only if these recur AFTER #181's bisect window is exhausted.
- pack-mint-probes firing-but-not-succeeding (12 runs, 0 ok) = EXPECTED per focus (backward walk on mainnet24 historical node). Not flagged.
- topshot-pack-supply-atlas 189 fails/24h = the Atlas pack-supply upstream-403 lane (info; last 200 at 00:03Z, nothing lost) — known.

## Sweep coverage note
- Sentry connector requires re-auth this run (unavailable) — Sentry not checked.
- Artifact validation: the 11 legacy desktop live artifacts cannot be opened/updated from this session; validated their backing views/RPCs directly instead (v_rpc_trust_health 38, v_tracked_wallet_fmv_confidence 20, v_rewards_economy 1, v_topshot_pack_lifecycle_global 1, pack_table_rows 6694, panini_squeeze_totals 1, get_active_challenges 1, mv_pack_ev_latest 1910) — all respond, no daytime schema break.
- **inbox written to mount, push unavailable** (no authenticated pushurl, no .rpc-git-cred, no credential helper reachable; git against the Windows-mounted .git is forbidden). Night pass picks this up locally.

---

## ✅ DISPOSITIONED 2026-10-11 (Claude Code, indexing this filing)

Filed to the mount with no push. Claude Code committed and indexed it on 10-11. All three candidates were already dispositioned elsewhere:
- **#1 pg_net 401:** aged out of the snapshot by this run's own 0307Z tick. Not re-observed by the 10-11 night pass.
- **#2 misattrib-drain 1544 > 500:** this is the #101 backlog, and it is draining: 1,838 on 10-10, 1,544 at 0008Z, 1,512 at 0307Z, 1,485 at the night pass. See `docs/handoff-2026-10-11-overnight-pass.md` QUEUED #3.
- **#3 allday-storefront-reconcile failure_rate:** aged out of the snapshot by the 0307Z tick. Chronic single-walk noise. No action.
