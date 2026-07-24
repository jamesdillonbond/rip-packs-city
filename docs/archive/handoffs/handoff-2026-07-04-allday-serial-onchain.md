# Handoff — Rewrite `sales-serial-backfill` AllDay path from dead GQL to on-chain `AllDay.borrowMomentNFT`

**Date:** 2026-07-04
**Author:** Claude Code (session close-out)
**Owner to execute:** Claude Code (edge-function edit + `deploy_edge_function`)
**Priority:** LOW–MED — historical serial enrichment; not FMV / deal-board / user-facing blocking. Do it when picking up the AllDay-serial thread.

---

## Goal

Rewrite the **AllDay** path of the `sales-serial-backfill` edge function so it resolves serials **on-chain** via `AllDay.borrowMomentNFT`, replacing the permanently-dead AllDay consumer GraphQL call. Once live, the ~276 currently-escrowed AllDay serials get picked up **automatically** as their moments exit Dapper escrow and return to a public collection — no manual re-runs, no dead-endpoint retries.

## Why (context from today's 2026-07-04 recovery)

- **AllDay GQL is dead permanently for our egress.** Both `nflallday.com/consumer/graphql` (`/allday-consumer`) and `public-api.nflallday.com/graphql` (`/allday`) are hard-blocked by Cloudflare against the worker egress IPs — every request returns `403 / error code 1009` (region/IP ban) or 404. This is an upstream ban; a byte-identical request change cannot fix it. See memory `allday-consumer-gql-cf1009-blocked`.
- **The on-chain path works and is proven at scale.** `AllDay.borrowMomentNFT(address, nftID)` returns the moment's `serialNumber` + `editionID` directly. Today we used this exact accessor to recover **8,964 / 9,675** AllDay NULL-serial sales.
- **The `sales-serial-backfill` fn still calls the dead GQL.** Its `fetchSerialsAllDay()` (lines ~133–225) POSTs `searchMomentNFTsV2(byFlowIDs:)` to `ALLDAY_CONSUMER_PROXY_URL` — the blocked endpoint. So its AllDay leg resolves ~nothing and just records `gql_404` / `unknown` failures every run.
- **The residual 711 NULLs are provably un-borrowable, not a bug.** Of the 9,675 AllDay NULL-serial sales, 8,964 recovered on-chain; **711 remain NULL** and stay NULL by design:
  - **~276 escrowed** in Dapper's Leaderboard/marketplace escrow contract. While escrowed, the moment is NOT in a public `/public/AllDayNFTCollection` capability, so `borrowMomentNFT` returns `nil`. **These auto-resolve once the moment exits escrow** — which is the whole point of moving this onto the scheduled fn.
  - **rest burned** — moment no longer exists on chain; `borrowMomentNFT` returns `nil` forever. Correctly un-resolvable.

The proven template already exists in-repo: **`supabase/functions/backfill-allday-listing-serials/index.ts`** (pipeline `allday-listing-serial-backfill`, healthy). It was itself rewritten 2026-06-20 off the same dead GQL onto on-chain borrow. **Copy its borrow mechanism verbatim.**

---

## The one genuinely-new piece: resolving the current holder

`backfill-allday-listing-serials` already knows each moment's holder — a floor **listing** carries `cached_listings_v2.seller_address`, and the moment stays in the seller's collection while listed (V1 Dapper NFTStorefront lists by capability, not escrow). A historical **sale** row has no such address. So the sales path needs one extra step: **find the moment's current holder before borrowing.**

`borrowMomentNFT(address, nftID)` requires the address whose collection currently holds the moment. Source it, in preference order:

1. **Most-recent sale buyer (cheapest, DB-only, no extra chain read).** The buyer of the latest `sales` row for that `nft_id` is the most-likely current holder. Resolve the actual end-user via the forward `AllDay.Deposit` attribution already used elsewhere (the recorded `buyer` is often the Dapper intermediate — see memory `allday-sale-buyer-is-dapper-intermediate`). If the moment has since moved, the borrow returns `nil` and the row is left NULL for a later run — acceptable.
2. **`wallet_moments_cache` current ownership** — if the moment is in `wmc` for a wallet under the AllDay collection, that wallet is the live holder. Most authoritative when present.
3. **Fallback: skip → leave NULL.** No holder found (escrowed / burned) → record a `no_holder` failure and move on. This is the correct outcome for the 711 residual.

This differs from the listings fn (which is handed the seller) — it's the only real design addition. Everything downstream (the borrow script, Cadence-JSON unwrap, retry/backoff, `update_sale_serial` write) is a straight copy.

---

## Files to touch

### 1. `supabase/functions/sales-serial-backfill/index.ts` (the rewrite)

Replace the AllDay leg. Concretely:

- **Delete / stop using** `ALLDAY_GQL_QUERY` (line 62), `ALLDAY_CONSUMER_PROXY_URL` (lines 47–48), and the body of `fetchSerialsAllDay()` (lines 133–225).
- **Add** the on-chain borrow, copied from `backfill-allday-listing-serials`:
  - `FLOW_REST` const (`https://rest-mainnet.onflow.org`, override via `FLOW_REST_URL`).
  - `BORROW_MOMENT_SCRIPT` — verbatim from `backfill-allday-listing-serials` lines 71–84:
    ```
    import AllDay from 0xe4cf4bdc1751c65d
    access(all) fun main(buyer: Address, id: UInt64): {String: String}? {
      let col = getAccount(buyer).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
      if col == nil { return nil }
      let nft = col!.borrowMomentNFT(id: id)
      if nft == nil { return nil }
      return { "id": nft!.id.toString(), "editionID": nft!.editionID.toString(), "serialNumber": nft!.serialNumber.toString() }
    }
    ```
  - `unwrapCdc()` + `runScript()` helpers — verbatim (lines 108–152).
  - A `resolveHolderForSale(target)` helper implementing the holder-resolution order above (query latest `sales` buyer for the `nft_id`; optionally consult `wmc`).
  - A `resolveOne()` that: resolves holder → borrows → reads `serialNumber` → `nil` means no-write (moved/escrowed/burned).
- **Rewire `runCollection()`** for the AllDay branch (lines 301–320): replace the single batched GQL call with a bounded-concurrency pool (`CONCURRENCY = 8`, `MAX_RETRIES = 2`, `SOFT_BUDGET_MS ≈ 130_000`) over per-target on-chain borrows, mirroring the listings fn's worker pool (lines 291–306). The **TopShot branch (lines 321–341) stays exactly as-is** — TopShot's `getMintedMoment` via `topshot-proxy` is healthy; do not touch it.
- **Reuse the existing write path unchanged** — `applyResult()` → `update_sale_serial` (only writes when current serial is 0/NULL and resolved serial is a valid positive int; re-runs are safe) and `record_serial_backfill_failure` for the escrowed/burned/no-holder cases (`reason: "no_holder"` or `"gql_null_serial"`→rename to `"onchain_nil"`).

Cross-check the Cadence against the live contract before deploy — memory `feedback_flow_cadence_args` (UInt64 args must be `String(v)` in the Flow REST arg encoding, which the copied `runScript` already does) and the CLAUDE.md AllDay Cadence gotcha (`borrowMomentNFT` on the concrete `&AllDay.Collection` at `/public/AllDayNFTCollection` — do NOT swap to the generic `borrowNFT` cast).

### 2. (Optional) schedule note
The fn's header (lines 6–7) says "ad-hoc via curl (one-shot, NOT cron)". If the goal is for escrowed serials to auto-resolve as they exit escrow, the AllDay leg wants a **recurring** trigger (e.g. daily, `board_only:false`, small batch). Either add a cron-job.org entry or fold an AllDay sweep into an existing daily cron. Keep it low-cadence + bounded — the 711 residual only shrinks as moments organically leave escrow, so a daily 200-target sweep is plenty. Update the header comment if you wire a schedule.

---

## Verification

1. **Deploy:** `deploy_edge_function` for `sales-serial-backfill` (Supabase project `bxcqstmqfzmuolpuynti`).
2. **Invoke with the token** (see token note below):
   ```
   POST https://<project>.functions.supabase.co/sales-serial-backfill
   Authorization: Bearer $INGEST_SECRET_TOKEN
   body: { "collection_id": "dee28451-5d62-409e-a1ad-a83f763ac070", "batch_size": 200 }
   ```
   Returns `202 accepted` immediately; work drains via `EdgeRuntime.waitUntil`.
3. **Confirm AllDay NULL serials decrease** (baseline captured this session = **711**):
   ```sql
   SELECT COUNT(*) FROM sales
   WHERE serial_number IS NULL
     AND edition_id IN (SELECT id FROM editions WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070');
   ```
   Expect it to hold at 711 initially (all remaining are escrowed/burned), then **tick down over days/weeks** as escrowed moments release. A large immediate drop would mean today's on-chain recovery missed a resolvable cohort — investigate if so, but 711 is the measured floor.
4. **Confirm the run logged clean:** the fn logs per-collection stats via console; the escrowed/burned rows show as `record_serial_backfill_failure` with an on-chain-nil reason (expected, not a regression). No `403 / 1009 / gql_404` reasons should appear for AllDay anymore — their disappearance is the proof the dead endpoint is gone.

---

## Revert path

Pure edge-function change, no DB/migration/schema impact.

- **Git:** `git revert` the commit, then `deploy_edge_function` to redeploy the prior `sales-serial-backfill` (the current dead-GQL version). Because the AllDay GQL is dead, reverting simply returns the AllDay leg to resolving ~nothing — harmless, just useless. The TopShot leg is untouched either way.
- No data to roll back — `update_sale_serial` only ever fills a NULL/0 serial with a valid positive int; it never overwrites a good value, so a bad deploy cannot corrupt existing serials.

---

## Token requirement note (important)

`sales-serial-backfill` requires `INGEST_SECRET_TOKEN` (Bearer `Authorization`, or `?token=<value>`). **This token is blank in `.env.local`** (memory `smoke-test-token-blank-locally`), so the fn **cannot be invoked from a local shell / MCP session** — it must be triggered from an environment that has the secret: the deployed Supabase runtime (which has it as an env var), a cron-job.org entry with the Authorization header set, or `curl` with the real token pasted by the operator. The edge fn itself reads `INGEST_SECRET_TOKEN` from its own Supabase-side env, so once deployed the auth check works server-side regardless of the local blank. Do **not** attempt to invoke it from this session's shell expecting it to authenticate.

---

## Summary

| | |
|---|---|
| **Change** | AllDay leg of `sales-serial-backfill`: dead consumer-GQL → on-chain `AllDay.borrowMomentNFT` |
| **Template** | `supabase/functions/backfill-allday-listing-serials/index.ts` (copy borrow mechanism) |
| **New logic** | Resolve current holder (latest-sale buyer / wmc) before borrowing |
| **Touch** | `supabase/functions/sales-serial-backfill/index.ts` (+ optional cron entry) |
| **Untouched** | TopShot leg, write path (`update_sale_serial`), DB schema |
| **Baseline** | 711 AllDay NULL serials remaining (all escrowed/burned; the resolvable 8,964 recovered 2026-07-04) |
| **Success** | AllDay NULL count ticks down over time as escrowed moments release; no `1009/403/gql_404` reasons in failures |
| **Revert** | `git revert` + redeploy; zero data risk |
