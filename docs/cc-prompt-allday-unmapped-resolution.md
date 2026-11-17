# Claude Code prompt — drain the AllDay unmapped-sales edition backlog (on-chain current-holder)

Paste to a Claude Code session. Read the repo + verify every premise against live code/DB before changing anything (figures below were verified live 2026-06-27 but re-measure).

## Problem
`unmapped_sales` for AllDay (`collection_id = dee28451-5d62-409e-a1ad-a83f763ac070`) has **576 open priced rows** (`resolved_at IS NULL AND price_usd > 0`): **29 recent (sold ≤14d)** + **547 old `allday_v1_history` backfill (sold from 2026-04-08)**. They are real, correctly-priced AllDay secondary sales held OUT of `public.sales` because their **edition** isn't resolved → AllDay sales undercount (~2% of AllDay volume). This is NOT a price problem (`recover-v1-budget-exhausted` is irrelevant) and NOT the consumer-GQL 403 (separate issue).

## Root cause (proven on-chain this session — do not re-litigate, but re-confirm)
The resolver `app/api/cron/allday-resolve-unmapped/route.ts` Leg B already borrows the edition on-chain via `AllDay.borrowMomentNFT` — but **against the sale-time `buyer_address`**. AllDay moments get re-deposited out of the buyer's wallet ~9 min (~439 blocks) after the sale, so by resolve time the buyer holds 0 and the borrow returns nil (`pipeline_runs` shows `onchain_nil ≈ 60`/tick, `onchain_resolved ≈ 0`, `promoted 0`). The `buyer_address` is correct (it matches `AllDay.Deposit.to` in the sale tx) — it's just stale. `borrowMomentNFT` needs the **current** holder. This is why even a 1-day-old row fails, and why fresh rows keep accumulating.

## Infra that already exists (reuse it — no new RPC, no new proxy)
- `lib/chains/flow/allday-edition-onchain.ts`: `BORROW_MOMENT_SCRIPT` (returns `editionID`+`serialNumber` via `AllDay.borrowMomentNFT` at `/public/AllDayNFTCollection`), `runAllDayScript` (hits **Flow REST `rest-mainnet.onflow.org` directly — WAF-proof from Vercel egress**, no worker proxy), `GET_EDITION_DATA_SCRIPT` + `buildOnChainEditionRow` (self-seeds a missing edition).
- DB applier `resolve_unmapped_sales_for_collection(p_collection_id uuid, p_rows jsonb, p_promote_limit int)` — writes `nft_edition_map` + promotes into `sales`. Already called at route ~:280.
- Editions catalog is ~complete (6,191), and the resolver self-seeds any miss, so **resolving editionID alone suffices** — no seeding step.

## Phase 1 — current-holder fallback (drains the 29 recent + STOPS forward accumulation = the bigger win)
Extend Leg B of `app/api/cron/allday-resolve-unmapped/route.ts`: keep the fast buyer-borrow first; when it returns nil, fall back to a **forward `AllDay.Deposit` event scan → current holder → borrow**:
1. From the row: `nft_id` + `block_height` (both already columns on `unmapped_sales`).
2. Scan event type `A.e4cf4bdc1751c65d.AllDay.Deposit` forward from `block_height` in ≤250-block chunks (Flow REST `/v1/events` range cap), tracking the latest `to` whose payload `id == nft_id` → that's the current holder.
3. Borrow `editionID`/`serial` against that holder with the existing `BORROW_MOMENT_SCRIPT`.
4. Feed `(nft_id → editionID, serial)` into `resolve_unmapped_sales_for_collection` (existing) — it maps + promotes.
- **Bound it:** a per-run scan budget (cap total Deposit blocks scanned per tick; mirror the existing `ON_CHAIN_MAX=60` discipline) so the cron stays well under `maxDuration` (≤800). Recent rows have short forward spans → drain in a tick or few.
- Net effect: also fixes the **forward accumulation** — most fresh AllDay sales fail buyer-borrow for the same 9-min re-deposit reason, so the current-holder fallback resolves them on the next tick instead of letting them accrue.

## Phase 2 — the 547 old April rows (optional; decide explicitly)
A per-nft forward scan from April (~6M blocks) is infeasible. If you want them gone: do ONE linear `AllDay.Deposit` walk from the April window → chain head, building a single global `nft_id → latest-holder` map for all ~536 stuck nfts at once (not per-nft), in a one-shot admin route/script, then borrow+resolve each. Heavy but bounded + one-time. Otherwise **leave them** (historical, quarantined out of `sales`, ~2% of AllDay; the per-collection trust-health metric `unmapped_resolution_backlog_max` already tolerates this). Recommend deciding by whether a real AllDay surface visibly undercounts.

## Verify
- `allday-resolve-unmapped` cron starts logging `onchain_resolved > 0` / `promoted > 0`.
- `SELECT count(*) FROM unmapped_sales WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND resolved_at IS NULL AND price_usd>0;` trends down from 576; the 29 recent fall to ~0 over a few ticks; new priced rows resolve within a tick or two.
- Spot-check a promoted row landed in `sales` with the right edition (verified example: nft `8931044` → editionID `3665` = Trey McBride Base).
- No regression: `v_fmv_sanity_flags` = 0; trust-health `allday_fmv_stale_hours` ok; AllDay editions count stays flat (self-seed shouldn't balloon it); deploy READY + smoke.

## Revert
`git revert` the route commit. No DB migration (reuses existing RPC + scripts). If Phase 2 adds an admin route, revert it separately.

## Gotchas
- Flow REST `rest-mainnet.onflow.org` direct is the WAF-proof path. Do NOT route AllDay edition reads through the consumer-GQL `/allday-consumer` (Cloudflare-WAF-blocked — the separate 403 issue).
- Before trusting `AllDay.Deposit` field names (`id`, `to`), verify against the deployed contract via the Cadence MCP (AllDay at `0xe4cf4bdc1751c65d`).
- The route passes `p_rows` as a JS array to a `jsonb` param — supabase-js serializes it fine; keep that shape.
- Off-limits reminder: this is sales-path logic — small, additive Leg-B fallback only; don't refactor the indexer.
