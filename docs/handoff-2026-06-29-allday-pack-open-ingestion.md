# Handoff — AllDay pack-open ingestion is edge-fn-doable (Phase 2 re-scoped + verified) (2026-06-29, Cowork)

The earlier handoff (`docs/handoff-2026-06-28-allday-pack-lifecycle.md`) scoped AllDay opened/sealed/realized-pull as **worker-gated** and flagged "verify the event signature with the Cadence MCP first." Both unknowns are now **resolved empirically**. This re-scopes Phase 2 off the Cloudflare worker entirely and hands it off fully specified. No production writes were made this session (deliberate — see "Why not shipped").

## The two unblocks (verified, not assumed)

**1. Flow REST is reachable from Supabase egress.** `https://rest-mainnet.onflow.org` returns 200 from both pg_net and an edge function (the same egress that already reaches the Dapper Studio Platform for supply). So AllDay pack-open ingestion can be a **Supabase edge fn + cron**, exactly like `backfill-allday-pack-supply` — it does **not** need the `pack-events-ingest` Cloudflare worker (which only does Top Shot and deploys via manual wrangler).

**2. The open signature, verified on a real open tx.** Trevor opened a single-moment AllDay pack ~14:4x UTC 2026-06-29. Found + decoded his exact tx:
`bf5e22c630d69ca7513e293eda2c9cca5fff47edd77ad94685bb6a1ebc55edf7` (block 156,415,584).

Events in an AllDay pack-open tx:
- **`A.e4cf4bdc1751c65d.PackNFT.Opened{ id: <packNFTid> }`** — fires **once per pack opened**. THIS is the missing "opened" signal → drives opened-count and depletion.
- **`A.e4cf4bdc1751c65d.AllDay.Deposit{ id: <momentNFTid>, to: <opener> }`** — one per revealed moment, withdrawn from the Dapper mint vault `0xb6f2481eba4df97b` and deposited to the opener. These are the **realized pulls** (count = `moments_pulled`; resolve each to an edition+FMV for realized value).

JSON-CDC shape: event payload (base64) → `{ value: { fields: [ {name, value}, ... ] } }`; unwrap typed/`Optional` via `.value.value`. (Working reference: the deployed gated read-only fn **`find-allday-pack-open`** does scan→decode→tx-fetch; **`probe-allday-pack-events`** is superseded — both are inert, delete or reuse.)

## Dist attribution — use the mint event, not pool overlap

For per-dist depletion you must map `pack_nft_id → dist_id`. **Pool overlap is ambiguous** for AllDay (verified: Trevor's pulled edition `4341` sits in **68** different dist pools, so a single-moment pack can't be disambiguated by its pull). The clean path:
- Ingest **`A.e4cf4bdc1751c65d.PackNFT.Mint{ distId, id }`** (the mint event carries `distId` — this is how `pack_purchases.pack_dist_id` is already populated for 431 AllDay packs) → authoritative `pack_nft_id → dist_id`.
- Join opens (`PackNFT.Opened.id`) to that map → per-dist opened count → `depletion = opened / total_minted` (denominator = `allday_pack_supply.total_minted`, already durable).

## Build recipe (edge fn + cron, mirrors `backfill-allday-pack-supply`)

1. **Cursor** — a small `allday_open_ingest_cursor(name, height)` (or reuse `event_cursor`). Forward cursor from a recent height; backward backfill cursor walking down. Opens are sparse so empty 250-block event queries are cheap, but the historical range spans AllDay's life — a gentle multi-tick cron, not one run.
2. **Per 250-block window**: `GET /v1/events?type=A.e4cf4bdc1751c65d.PackNFT.Opened&start_height=&end_height=`. For each opened pack: fetch `GET /v1/transaction_results/{tx_id}`, collect same-tx `AllDay.Deposit` events (moment ids + opener), and the `PackNFT.Mint` map for `dist_id` (or resolve from `pack_purchases`).
3. **Write `pack_rips`** (collection_id = AllDay `dee28451-…`): `pack_nft_id`, `opener_address`, `moments_pulled`, `tx_hash`, `block_height`, `sealed_at` (block ts), `dist_id`. **Schema caveat:** `pack_rips` PK is `id` only — **add `UNIQUE(collection_id, pack_nft_id)` first** (check the 190,994 TS rips for dups before adding) so upserts are idempotent; respect the existing `pack_rips_propagate_dist_trg` trigger. Realized pull value can reuse the existing `backfill_pack_rip_metadata` pattern (resolve pulled moments → editions → FMV).
4. **Surface it** — the TS lifecycle views (`v_topshot_pack_lifecycle`, `_realized_ev`, `_edition_pull_provenance`) **hardcode the TS collection_id**. Clone an AllDay variant (or parametrize a generic `v_pack_lifecycle(collection_id)`), then add opened/sealed/depletion to `v_allday_pack_info` (currently NULL by design) and the packs page.

## Why not shipped this session (deliberate)

A parallel session is actively committing to this repo, and a production ingester writes to the **shared `pack_rips`** core table and needs a **schema change** (the unique constraint) on a 190k-row table. Rushing that mid-parallel-session is the kind of avoidable collision the cross-session rules warn about. The hard, unknowable parts (reachability, exact signature, attribution path, schema gotchas) are now all verified, so the build is mechanical and low-risk **when done deliberately**. Recommend: confirm no parallel pack work in `docs/overnight/ledger.md`, add the unique constraint, build the edge fn + gentle backfill cron, generalize the view.

## Guardrails / cleanup
- Direct to `main`. New views `security_invoker` + anon-SELECT. Gentle cron (cost-flat); opens are sparse so it self-paces.
- Reference edge fns `find-allday-pack-open` + `probe-allday-pack-events` are gated/read-only/inert — delete or reuse.
- Priority note carried from the prior handoff: AllDay ended primary sales, so this is the historical-open tail — valuable for pack-reality/depletion, lower ROI than Top Shot. Worth it now that it's de-risked to an edge-fn build.
