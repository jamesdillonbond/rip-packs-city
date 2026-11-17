# Claude Code queue — 2026-06-22 (the off-limits route/ingest items Cowork can't safely ship)

Everything from the 2026-06-21/22 Cowork audit that Cowork could do is shipped + verified live (concierge model + Flowty de-rec, pack-reality median, CSP thumbnails, Flowty marketplace teardown `dbdbd0dd`, pg_cron monitor fixes, scheduled-task wiring, badge-catalog cron deleted). What's left needs local testing + secret/proxy access — i.e. Claude Code. All LOW/MED, nothing is broken. Platform GREEN (security 0/0/0/0, trust 9/9, pg_cron clean, Sentry 0 real, Vercel 0 ERROR).

Paste the block below into Claude Code.

---

Work these RPC follow-ups; each is independent. Commit to `main`, tsc-clean, log each in docs/overnight/ledger.md with a revert path.

1. [MED] topshot-buyer-backfill per-invocation overlap. `app/api/admin/backfill-topshot-buyers/route.ts` runs 600–710s and its cron fires ~4×/hr, so invocations OVERLAP and self-contend (max ~710s, dangerously near the 800s Pro maxDuration cap — and >800 silently ERRORs the deploy, so you can't raise it). Fix the contention, not the cap: cap rows-per-invocation (lower BATCH so each run finishes comfortably inside the cron interval) and/or add a run-lock (advisory lock or a `pipeline_runs`-based "already running" guard) so a second concurrent invocation early-exits. Verify post-deploy: runs no longer overlap, max duration drops well under 800s, 0 fails, detect_stalled_pipelines() stays [].

2. [LOW] Seed the 72 missing UFC editions. `ufc-enrichment-drain` resolves wmc edition_keys faster than the UFC editions seed, leaving 72 editions (166 wmc rows) held by wallets but absent from `editions` — breaks the wmc->editions invariant for UFC (no FMV corruption; UFC FMV is all NO_DATA, just thin metadata). List them: SELECT DISTINCT edition_key FROM wallet_moments_cache w WHERE collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023' AND edition_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.external_id=w.edition_key AND e.collection_id=w.collection_id);  Fix: seed those editions via the UFC edition ingest path, or give ufc-enrichment-drain a companion edition-seed for keys it resolves that aren't catalogued.

3. [LOW] AllDay V1 unmapped drift. ~57 open `unmapped_sales` for nfl_all_day; ~208 are `onchain_dapper_v1` with price KNOWN ($1–2) but edition UNMAPPED (nft_id->edition_key), inflow stopped, likely old/burned moments unmappable via consumer GQL; the rest are `v1_tx_decode_budget_exhausted` fossils. No data-integrity risk (held OUT of `sales`). Decide + implement: confirm the resolver actually attempts these 208 -> if so, reclassify as permanent residual (mark retired so they stop showing as "open"); if not, raise the recover-v1 cadence to drain them.

4. [LOW] TS wmc UUID fossils. 1,683 `wallet_moments_cache` rows keyed to merged/deleted UUID-pair TS editions (retired wmc_edition_key-drain era; stable, not growing). Self-heals only via a canonical-merge re-key onto the surviving int-pair edition (same class as the DUPE1 dedup). Re-key (with reversible audit capture) or formally accept as permanent residual.

5. [LOW] get_user_top_owned_moments 3-arg orphan. `a3db4235` added a 4-arg overload (SECDEF, authenticated); the 3-arg overload may now be orphaned. Verify no call sites reference the 3-arg signature, then DROP FUNCTION the 3-arg overload (destructive — verify first; the 4-arg stays).

6. [LOW] Smoke-test residual flakiness. Sentry JAVASCRIPT-NEXTJS-A ("smoke test failed: fmv pipeline healthy / analytics_pipeline_health", super_low, transient) still fires under DB-IO load — a leg CC's earlier analytics-smoke hardening didn't cover. In `app/api/smoke-test/route.ts`, make that leg resilient to the query-cancel/timeout class (retry once, or downgrade a timeout-class failure to warn, mirroring the existing isSaturationError pattern). After a few quiet ticks, resolve NEXTJS-A with regression arming.

DECLINED — do not attempt (premise overturned, already in the ledger Declined section): migrating the 106/185 ipfs.dapperlabs.com thumbnails to the assets CDN. IPFS is the canonical/only art for the 137 `::` parallels (migrating = NULL), and the 48 base editions return NOT_IN_SET from searchEditions (no CDN URL exists). The CSP fix `7fe106d3` already renders all 185.
