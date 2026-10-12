# Daytime monitor — 2026-10-12T00:10Z (~5:10 PM PT 10-11)

Read-only daytime sweep. Platform HEALTHY: security 4/4 clean ([] invariants / secdef_anon / rls_off_base / anon_write_holes), trust 38/38 ok (0 breaches; ts_uuid_dupes_created_24h 0), stalled_pipelines [], pg_cron recent failures [], sentinel ts_uuid_editions_48h 0, latest prod deploy READY (61d776db — "retire the dormant compute-laliga-pack-ev route"; the two CANCELED siblings are superseded rapid-push builds, no ERROR). DB 36,338 MB. NOT in a saturation spell (rpc_ops_snapshot + every probe returned fast; no IO-wait majority).

Candidates (low-risk; sensing only):

## 1. candy-offers-indexer failure_rate medium — 2/7 timeouts over 3 days (28.6%), undispositioned [P-low]
- **Source:** `rpc_ops_snapshot().pipeline_alerts` -> `candy-offers-indexer`: "2/7 runs failed (28.6%) over the last 3 calendar days. Last error: The operation was aborted due to timeout", severity medium. This is the native Candy offers indexer, DISTINCT from the candy-opensea-offers-indexer / #58 lane.
- **Risk read:** low. No data cost: `candy_offers_oldest_active_hours` 5.2 (ok, breach 36), `candy_offers_unverified_pct` 0 (ok). Both failures are timeouts, no logic error. Not in ledger / Declined / focus. The one prior candy-offers inbox file (2026-10-04T2112Z) was a different issue (offers book zeroed + 429 scratch decay), not this timeout class.
- **Suggested action (night pass):** quick-glance whether the 2 timeouts carry a real slow-query / contention cause vs a transient upstream hiccup; if chronic and benign (data stays fresh), add a one-line do-not-reflag disposition so future daytime passes skip it; if a genuine slow leg, that is the fix.

## Already filed / tracked (NOT new candidates — so the night pass does not double-count)
- **candy-opensea listings + sales indexers HIGH (6/6 = 100% fail, OPENSEA_API_KEY not set):** KNOWN issue #58, Trevor-gated (operator must set the env var); already filed `2026-10-11T0307Z-daytime-monitor-candy-opensea-indexers-missing-OPENSEA_API_KEY.md`. Misconfiguration, not an OpenSea outage. Not re-filed.
- **suppression_count_predicate_drift topshot-misattrib-drain 1,198 open vs <=500 bound:** the #101 backlog, DRAINING — 1,838 (10-10) -> 1,485 (10-11 night pass) -> 1,198 now, still falling toward the bound. Resolver jobid 720 (`rpc-topshot-misattrib-atlas-resolver`) succeeds every 5 min; all 5 misattrib cron jobs active. Tracked as `docs/handoff-2026-10-11-overnight-pass.md` QUEUED #3; first filed `2026-10-11T0008Z-...-misattrib-drain-drift.md`. Not re-filed.
- **panini-collector-walk failure_rate medium (6/20, "per-walk cap of 10 min reached"):** by design (walkOrder rotates the start collection); focus do-not-reflag.
- **atlas-editions / atlas-market / atlas-pack-supply upstream-403 + flow-rest-moment-moved-400 (all info):** by-design Cloudflare-challenge collateral / designed outcomes; fresh drains (last 200 / last ok within minutes); none at their escalation thresholds (0 stalled editions sets; market last drain 00:03Z; pack-supply last 200 00:04Z). topshot-pack-supply-atlas 199 fails/24h = this same by-design 403 lane (9/10 recent ticks ok, fresh 00:07Z).

## Sweep coverage note
- Sentry connector requires re-auth this run (unavailable) — Sentry not checked.
- Artifact validation: the 11 desktop live artifacts cannot be opened / payload-validated from this cloud session; validated their backing views + functions directly instead — v_rpc_trust_health, v_topshot_pack_lifecycle_global / _lifecycle / _realized_ev, v_tracked_wallet_fmv_confidence, v_rewards_economy / _user_balances, panini_squeeze_board, pack_table_rows, cross_collection_cohort_mat / _ts_set_overlap_mat, get_active_challenges, get_relative_deals, get_wallet_pack_history / _summary, get_rewards_summary, rpc_ops_snapshot — all present and resolve. Public boards 0 empty / 0 slow; board MV refresh 1.95h. No schema break from today's 10-11 migrations.

---

## ✅ FIXED 2026-10-11 ~9:30 PM PT (Claude Code, Trevor's box) — the activities leg degrades instead of aborting

**Cause, from the two failed rows:** both carried `hung_phase: discovery_activities`, `failed_at: uncaught`, `rows_written 0` (10-10 18:50Z at 50 s, 10-11 12:50Z at 34 s). A Magic Eden `/collections/<symbol>/activities` page hit the 15 s request timeout and the throw went straight to the outer catch, so the stored bidders were never re-swept and the book sat 12 h without a verification. Not a slow query and not contention: every other run in the window completed in 13–18 s with 0 bidder fetch errors.

**Shipped (code, `app/api/ingest/candy-offers/route.ts`):** a failed activities page is retried once (ME tarpits datacenter egress; slow, not broken), and a second failure is RECORDED and the walk skipped. Steps 2–6 then run as usual: every bidder with a stored active offer is re-discovered by step 2, swept, upserted, and the stale pass still runs, because the activities leg cannot turn an absence into a fetch artifact. The run reports `ok=false` with `bid-activity discovery failed after N page(s) (…)`, since bidders known only from a recent bid may be missing that tick. New `extra` fields: `activity_discovery_error`, `activity_pages_read`, `activity_retries` (NULL / 0 on a clean walk). Pinned in `__tests__/api-ingest-candy-offers-deep.test.ts`: the degrade contract, the retry, and a no-change control on the happy path; both planted defects (error discarded; retry removed) red the expected tests.

**Do-not-reflag reading for later passes:** a `candy-offers-indexer` run that is `ok=false` with `activity_discovery_error` set and `rows_written > 0` is the degraded path working as designed. Re-flag only if `activity_discovery_error` is set on most ticks in a day (ME's activities feed down, not a hiccup) or if `rows_written` is 0 on such a run.
