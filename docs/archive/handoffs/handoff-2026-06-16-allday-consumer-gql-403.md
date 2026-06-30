# Handoff 2026-06-16 — AllDay V1 sales silently undercounting: consumer-GQL 403 breaking edition-resolution

Found via a proactive data-quality pulse (the autonomous monitor had flagged "ALLDAY-UNMAPPED-CLIMB 94→256, resolver healthy" but mis-read it as benign — see the monitoring note below). This is a real, ~3-week-old, currently-ESCALATING silent data-quality issue. The fix is worker/edge-function (consumer GQL access) — not a clean Cowork-DB ship — so it's handed off. Diagnosis is complete; nothing changed by this doc.

HEAD at write: origin/main = 6c54162.

---

The finding

A growing share of AllDay's V1 Dapper sales (the native AllDay marketplace, `source=onchain_dapper_v1`) fail to map to an edition and pile up unresolved in `unmapped_sales`, so they never reach the `sales` table. AllDay's sales / FMV / analytics / cohort all undercount by that share.

Sized (2026-06-16):
- AllDay sales landed in `sales`, last 24h: 757 (734 are V1 Dapper).
- AllDay sales that FAILED to map, last 24h: 150 → a ~16% miss rate on V1 right now.
- Open unmapped AllDay: 243 (234 distinct nft_ids), of which 209 are retry-exhausted (the graveyard) and 34 are the known zero-price budget-exhausted residual (correctly held — not this bug).
- It SPIKED in the last 24h: 150 of the 209 7-day failures landed in the last day (vs ~10/day before). It is getting worse, not stable.

Root cause (recorded in `unmapped_sales_resolution_failures`)

- failure_reason = `no_edition_id_both_sources` (366 such failures, oldest 2026-05-28, newest today).
- failure_detail sample: `consumer_gql:http_403:<title>block</title> ... | flowty:flowty_id=521168`.
- So the resolver's PRIMARY edition lookup — AllDay's consumer GraphQL `nflallday.com/consumer/graphql` (searchMomentNFTsV2 byFlowIDs → editionFlowID, via the topshot-proxy `/allday-consumer` route) — is returning an HTTP 403 bot-block page (Cloudflare-style). The Flowty fallback is dead (shut down 2026-05-13), so both sources fail → the row can't be mapped → after 5 retries it's retry-exhausted and `get_unmapped_resolver_targets` permanently drops it (NOT EXISTS retry_count>=5).
- The block is INTERMITTENT (734 V1 sales DID resolve in 24h), but the 403 rate rose sharply in the last day. The resolver itself logs healthy (running, 0 fails) while `targets_returned:0 / mappings_written:0` — it's quietly doing nothing.

The resolver is the Supabase edge function `supabase/functions/allday-unmapped-resolver/index.ts` (rewritten 2026-05-25 to consumer-GQL-primary). Its targets come from `get_unmapped_resolver_targets` (DB RPC).

---

Likely fix (verify first)

searchMomentNFTsV2(byFlowIDs) is documented (CLAUDE.md API contracts) to live on BOTH endpoints: the consumer endpoint (`/allday-consumer`, now 403ing) AND the public-api endpoint `public-api.nflallday.com/graphql` (worker route `/allday`). The public-api route is HEALTHY right now — `allday-fmv-populate` hits it every tick with 0 fails. So the most promising fix is:

1. Point the resolver's searchMomentNFTsV2 edition-resolution at the `/allday` (public-api) route instead of `/allday-consumer`. VERIFY first that public-api's searchMomentNFTsV2 returns `editionFlowID` for a sample of the failing nft_ids (e.g. 817313, 979561, 1330064 from the recent failures) — the consumer endpoint may have been chosen originally because its shape carried editionFlowID; confirm parity before swapping.
2. If public-api doesn't carry editionFlowID, browser-fingerprint the `/allday-consumer` worker route (Origin/Referer/UA — the proven `allday-consumer`-style trick) to get past the 403. Caveat: the A1 work (commit `a126f44`, 2026-06-15) found the TS *website* marketplace endpoint sits behind a Cloudflare *managed challenge* that fingerprinting did NOT beat — so test before relying on it. The public-api route (option 1) is the safer bet since it already works.
3. Make the resolver resilient to transient 403s: a 403/rate-limit is TRANSIENT, but the current retry logic permanently graveyards a row after 5 such failures. Treat the 403/bot-block class as retryable-with-backoff (don't count it toward the permanent retry_count, or give it a long cooldown), so an intermittent block doesn't strand resolvable sales forever.

After the fix — drain the graveyard
- Reset the retry-exhausted rows so they become targets again (mirror the 2026-05-25 un-retire migrations): `DELETE FROM unmapped_sales_resolution_failures WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND failure_reason='no_edition_id_both_sources';` (or set retry_count=0). Then the chained resolver re-attempts them and `promote_unmapped_sales` lands them in `sales`. Do this only AFTER the consumer-GQL access is fixed, or they just re-fail.
- Verify: `unmapped_sales` open AllDay count falls; `allday-unmapped-resolver` extra shows `mappings_written > 0`; AllDay `sales` 24h count rises toward the true ~900/day.

Monitoring blind spot (worth closing)
The autonomous monitor reported the resolver "healthy" because it runs with 0 fails — but it was resolving nothing (`targets_returned:0 / mappings_written:0`) while the backlog grew. The health check should flag a resolver that runs clean but writes 0 mappings while `unmapped_sales` is climbing (throughput, not just run-success). Consider a `pipeline_cadence`/trust-health tripwire on AllDay unmapped backlog growth or on resolver `mappings_written=0` over N consecutive runs.

---

Guardrails
- This is sales-ingest/resolution logic — verify the GQL parity on real failing nft_ids before swapping routes; don't blind-ship.
- Workers deploy manually (`wrangler deploy` in workers/topshot-proxy) — not via git push. The resolver edge function deploys via Supabase. Direct-to-main for the repo bits; PowerShell git on Windows.
- Claude Code's direct inspection of the resolver + worker wins over this doc — adapt to the actual code.

Expected end state: AllDay V1 sales resolve again (consumer-GQL access restored or routed to public-api), the 209-row graveyard drains, AllDay sales/FMV stop undercounting, and the monitor gains a throughput tripwire so a silent resolver stall is caught next time.
