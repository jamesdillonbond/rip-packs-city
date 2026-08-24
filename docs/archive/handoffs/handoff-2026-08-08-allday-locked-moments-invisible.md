# Handoff — All Day wallet backfill misses LOCKED moments (invisible holdings)

**Date:** 2026-08-08 (PT)
**Author:** Cowork session (Trevor-directed)
**Type:** Investigation + fix recommendation. Route/lib code — for Claude Code.
**Risk of the fix:** Medium (changes the All Day enumeration source). Read the caveats.

## Symptom

New signup `visiondist@gmail.com` / wallet `0xdcd41c74d2dd0a66` (All Day username **ThunderHour**) shows **0 All Day moments** in RPC after a full multicollection backfill, but his live All Day profile shows **3 moments — all locked** (padlock icon on every card: Mike Alstott Common #1/4999, Legendary #59/59, Rare #355/499).

Corroborating: he has **169 All Day sales as SELLER** from this exact wallet (2 as buyer), last on 2026-07-29 — he was a heavy All Day participant, not an empty wallet.

## Root cause (confirmed, not a hypothesis)

`app/api/wallet-backfill-allday` → `runAllDayDetailsBackfill` enumerates on-chain via the Cadence script `GET_UNLOCKED_MOMENT_DETAILS` in `lib/chains/flow/allday-cadence.ts`. That script borrows `/public/AllDayNFTCollection` and returns `getIDs()`. The file's own comment (lines 51–53) states the limitation:

> Returns [...] for all UNLOCKED moments in the wallet. **Locked moments are moved to Dapper custodial infrastructure and are NOT present on-chain.** Compare these nftIDs to a Flowty-sourced full list to determine is_locked.

So locked All Day moments are **not in the on-chain collection** and are structurally invisible to any `getIDs()`-based walk. The backfill run for his wallet logged `wallet-backfill-allday ok=true, rows_found=0, rows_written=0, no error` — a correct read of on-chain state that is nonetheless an incomplete read of his holdings.

The All Day pipeline is healthy platform-wide (512/667 wallets returned moments in 24h), so this is **not a broken pipeline** — it's a coverage gap specific to wallets whose All Day moments are locked. Anyone holding only locked All Day moments shows 0.

## Fix options

**Preferred — enumerate All Day holdings via GraphQL `searchMomentNFTsV2` (sees locked/custodial moments).** The official All Day site renders locked moments from this API, and RPC already talks to All Day consumer GraphQL (`lib/alldayGraphql.ts`, `allday-wallet-search`, routed through the `topshot-proxy` `/allday` + `/allday-consumer` routes). Switch the wmc backfill's All Day enumeration to the GQL owner query (which returns locked moments, typically with a lock flag/`lockExpiryTimestamp`), and set `is_locked` from that flag. Keep the Cadence path only if you still want an on-chain cross-check.

- ⚠ **Verify first (could not be done from Cowork — no Flow/GQL egress here):** confirm `searchMomentNFTsV2` (or the consumer-GQL owner query RPC already uses) actually returns locked moments for `ThunderHour` / `0xdcd41c74d2dd0a66`, and identify the exact lock field. Do this via the `topshot-proxy` `/allday-consumer` route before writing the enumeration.
- Preserve serial/edition hydration parity (`editionID`, `serialNumber`) that `GET_UNLOCKED_MOMENT_DETAILS` provides — GQL returns these directly.

**Alternative the comment itself suggests** — keep the Cadence walk for unlocked, and additionally pull a Flowty/dapper.market-sourced full owned-list to recover locked nftIDs, marking them `is_locked=true`. More moving parts; only worth it if the GQL owner query turns out not to include locked moments.

## Scope / related checks

- This is **All Day-specific** because All Day moves locked moments to Dapper custody (off-chain). **Top Shot** locking (`TopShotLocking`) keeps the NFT in the collection with a locked flag, so `getIDs()` still returns it — his 1,474 TS count is likely complete, but worth a spot check on a known-locked TS moment.
- **Pinnacle** — verify whether Pinnacle locking behaves like All Day (custodial/off-chain) or Top Shot (in-collection). If All Day-like, it has the same gap.
- Once fixed, re-run the multicollection backfill for `0xdcd41c74d2dd0a66` — his 3 locked All Day moments should appear.

## Verify after ship

- `visiondist@gmail.com` / `0xdcd41c74d2dd0a66` shows 3 All Day moments (all `is_locked=true`).
- A second known locked-All Day wallet also recovers its locked moments.
- No regression in unlocked All Day counts for existing wallets (compare wmc All Day totals before/after on a sample).
- CI green; ledger entry with revert path.

## Revert

`git revert <sha>` — code-only, no DB migration required (wmc rows self-heal on the next backfill).
