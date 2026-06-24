# Handoff — historical secondary-sales capture program (HIGH PRIORITY)

**Why this matters (Trevor, 2026-06-24):** the Recent Sales table + FMV history chart on moment/edition pages are core product, and right now most collections show shallow history because their secondary-sales were only indexed *forward* from a recent start date. This is a prioritized program to backfill historical secondary sales (native marketplace **and** Flowty) across collections. **Not Cowork-shippable** — capture needs on-chain reads and/or the proxy/spork-proxy secrets, which only the deployed workers/routes hold. Cowork's contribution: the precise gap map below, a shipped AllDay target queue, and confirmed feasibility boundaries (tested, not assumed).

## The gap map (live-measured 2026-06-24)

| Collection | Native captured (in `sales`) | Flowty captured | Real gap to backfill |
|---|---|---|---|
| **Top Shot** | 2020-07-28 → now, **618,408** (via `ts_history_backfill_v1` GQL) ✓ complete | flowty: **1,323**, 2026-03→05 only | **TS Flowty history** (~2022→2026) |
| **NFL All Day** | nflallday: **11,215**, only **2026-05-18 → now** (V1 Dapper indexer start) | flowty: 11,646 (2026) + 586 `flowty_archive_extractor` (back to 2023-11) | **AllDay native pre-2026-05-18** (biggest gap; 2,295 editions have ZERO sales) + Flowty pre-2026 |
| **Disney Pinnacle** | `pinnacle_sales`: **17,513**, only **2026-03-03 → now** | n/a — never on Flowty | **Pinnacle native pre-2026-03** |
| **LaLiga Golazos** | 37 (since 2026-05-31) | 23 | nearly all (native + Flowty) |
| **UFC Strike** | ~0 native | 55 | nearly all (native + Flowty) |

## Two capture mechanisms — prefer GQL where the API exposes per-moment sale history

**(A) GQL per-edition sales-history drain (preferred — the proven TS pattern).** `ts_history_backfill_v1` (`app/api/cron/topshot-sales-history-backfill/route.ts`) drains per-edition sale history from the Top Shot consumer/marketplace GQL — that's how TS has 600k+ sales back to 2020 without on-chain scanning. **Mirror it for AllDay and Pinnacle if their APIs expose per-moment/edition sale history:**
- **AllDay** — via the `topshot-proxy` `/allday-consumer` route (`nflallday.com/consumer/graphql`, `getMintedMoment` and related). Confirm whether it returns historical sales per moment/edition. (Cowork-tested: this host is Cloudflare-WAF-blocked from non-proxy IPs — **must go through the worker**, which holds `TS_PROXY_SECRET`.)
- **Pinnacle** — via `pinnacle-proxy`. Confirm the Pinnacle GQL exposes per-render sale history; extend `pinnacle-sales-indexer` to walk history, not just forward.
- Drive AllDay from the shipped queue **`public.allday_sales_history_backfill_targets`** (see below) — priority_rank ascending; it self-updates as `captured_sales` rises. Build the Pinnacle/Golazos/UFC analogues the same way.

**(B) On-chain event scan (required for Flowty — API dead + archive deleted).** Flowty wound down (API `api2.flowty.io` dead) and the raw Flowty archive was hard-deleted 2026-05-24, so **Flowty history is recoverable only from chain.** Walk `ListingCompleted` events on the storefront contracts via the **`spork-proxy`** (historical sporks; the public access node `rest-mainnet.onflow.org` only serves the *current* spork — Cowork-tested) and decode with the existing helpers:
- **Flowty fork (all collections):** `A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted` — filter by `nftType`; buyer via `fetchTxBuyers` (the event's `buyer` is the Flowty fee router, not the real buyer — see CLAUDE.md AllDay gotcha).
- **Native Dapper V1 (AllDay / Golazos / UFC pre-indexer):** `A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted`, decode via **`lib/dapper-v1-tx-decode.ts`** (buyer = `<collection>.Deposit.to`; price = `DapperUtilityCoin.TokensWithdrawn` from the DUC contract `0xead892083b3e2c6c`). Price-uncertain → `unmapped_sales`.
- Insert with the right `marketplace`/`source` (`onchain_dapper_v1`, `onchain` for Flowty fork, etc.); let the existing `*-unmapped-resolver` map editions; dedup on `transaction_hash`.

## Priority order (most product impact first)
1. **AllDay native pre-2026-05-18** — biggest gap on the #2 collection; 2,295 zero-sale editions. Try mechanism (A) via `/allday-consumer` first; fall back to (B) V1 Dapper for the depth GQL won't return.
2. **Pinnacle native pre-2026-03** — mechanism (A) via `pinnacle-proxy`.
3. **TS Flowty** — mechanism (B), Flowty-fork events via spork-proxy (TS native is already complete, so this is just the Flowty venue).
4. **Golazos / UFC** (native + Flowty) — smaller collections, lower traffic; same mechanisms.

## Cowork-shipped scaffolding
- **`public.allday_sales_history_backfill_targets`** (view, `security_invoker`, service_role+authenticated) — `audit_20260624_allday_sales_history_backfill_targets`. Self-updating prioritized work queue: `edition_id, external_id, player_name, set_name, tier, circulation_count, captured_sales, zero_sales, priority_rank`. As the backfill inserts sales, `captured_sales` rises and editions fall in `priority_rank`, so the route just drains by rank each pass — no manual status tracking. **Revert:** `DROP VIEW public.allday_sales_history_backfill_targets;`.

## Feasibility boundaries Cowork tested (so you don't re-discover them)
- `rest-mainnet.onflow.org` is reachable from a generic IP **but serves only the current spork** (latest height ~155.8M) → deep history needs `spork-proxy`.
- `nflallday.com/consumer/graphql` → **403 (Cloudflare WAF)** from non-proxy IPs → must use the worker (`TS_PROXY_SECRET`).
- `flowty_transactions` is a tx *classifier* (status/failure), **0 `ListingCompleted` payloads**, covers only 2026-04→05 → not a usable sales source.
- No captured-but-unpromoted sales backlog exists; the data genuinely wasn't indexed and must be re-captured from source.

## Verify (per workstream)
- `sales` (or `pinnacle_sales`) `min(sold_at)` for the collection moves back toward the collection's launch; per-edition `captured_sales` rises; `v_fmv_sanity_flags` stays 0 (no fake HIGH/MED — backfilled history is older, so confidence stays honest); `transaction_hash` dedup holds (no double-count); moment pages show deeper Recent Sales. FMV *confidence* won't jump (recency-driven) — the win is **history depth + coverage**, which is the point.

## Guardrails
Direct to `main`, no branches/PRs. PowerShell `git`. Vercel Pro `maxDuration` cap 800s. Rate-limit the proxy/spork-proxy walks (Flow 429s). Run smoke + confirm READY.
