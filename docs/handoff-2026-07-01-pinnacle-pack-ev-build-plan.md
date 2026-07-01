# Pinnacle Pack EV — feasibility + build plan (2026-07-01)

Handoff item #5. **Verdict: feasible and worth building, but a dedicated multi-stage build — NOT safely shippable/soakable in one session.** The gating unknown is the drop-pool/odds source, not the contract path. This doc records the confirmed on-chain facts so the build starts from truth, and stages the work.

## Confirmed on-chain facts (Cadence MCP, mainnet)

- Disney Pinnacle deploys `PackNFT` at **`0xedf9df96c92f4595`** (same account as `Pinnacle` + `PinnacleTrade`).
- `PackNFT.totalSupply` = **896,503** sealed packs currently on-chain → a real, large market (not thin). Building this is justified.
- Event signatures (from the deployed contract source):
  - **`A.edf9df96c92f4595.PackNFT.Minted(id: UInt64, hash: [UInt8], distId: UInt64)`** — carries `distId` **directly**, exactly like AllDay `PackNFT.Mint`. This is the primary-drop signal; every `Minted` is primary by definition. Buyer = matching `PackNFT.Deposit.to` in the same tx.
  - `PackNFT.Withdraw(id, from)` / `PackNFT.Deposit(id, to)` — transfers.
  - `PackNFT.Revealed(id, salt, nfts)` — **lists the pin NFT identifiers contained in the opened pack** (the empirical pool source; see below).
  - `PackNFT.Opened(id)` / `RevealRequest` / `OpenRequest` — lifecycle.
- Secondary pack sales route through `PinnacleTrade` / NFTStorefront at the same account (unverified event shape — decode a real secondary pack tx before ingesting it).

So the pack ingestion pattern is the **AllDay clone** (Mint-on-demand, distId in the mint event). `pack_purchases.event_kind = 'primary_mint'`, `pack_dist_id` populated from the event's `distId`.

## The gating unknown — the drop pool / odds (do this FIRST)

EV needs, per `distId`: (a) which pins the pack can yield, (b) their drop weights/odds, (c) the pack retail price. We have per-pin FMV already (`pinnacle_catalog.fmv_usd`, render-keyed). Two candidate sources — probe both before writing any ingestion:

1. **Pinnacle GQL (preferred, "modeled EV")** — via `pinnacle-proxy`. TS/AllDay expose pack contents + odds + retail price through GQL (`getPackListing` / `packEditionsV3`). **Probe the Pinnacle GQL schema for an equivalent pack/distribution query** (needs the proxy secret → operator/deployed-route, can't run from a tokenless session). If it exists → seed `pack_distributions` + `pack_drop_pool` for `disney_pinnacle` directly, then reuse the existing `compute_pack_ev_*` machinery unchanged.
2. **Empirical (fallback, "realized EV")** — scan historical `PackNFT.Revealed` events (each lists the pins that came out of a pack), map nft → render → pin, group by `distId` → empirical per-pack pool + realized-EV distribution. No published odds needed. Heavier (full historical event scan) and only realized-EV, not modeled-EV, but fully on-chain and source-independent.

If (1) is available it is far cheaper and gives modeled EV. Resolve this question first — it decides the whole build shape.

## Staged build plan (mirror the AllDay pack pipeline)

1. **Probe** the Pinnacle GQL for pack/distribution/odds (source decision above). Deliverable: yes/no + the query.
2. **Pack ingestion** — add a Pinnacle path to `pack-events-ingest` (or a new cron): scan `A.edf9df96c92f4595.PackNFT.Minted` → `pack_purchases` (`event_kind='primary_mint'`, `pack_dist_id`=distId, buyer via same-tx `Deposit.to`, `collection_id`=disney_pinnacle). New `event_cursor` row. Decode + add secondary (`PinnacleTrade`) after verifying its event shape.
3. **Drop pool** — from source (1) seed `pack_distributions` (with `retail_price_usd`, slot count) + `pack_drop_pool` (render→weight). From source (2) reconstruct empirically from `Revealed`.
4. **EV** — reuse `compute_pack_ev_per_edition_weighted` + `pack_ev_history`/`pack_ev_latest` + the realized/lifecycle views. Per-pin FMV already exists (`pinnacle_catalog.fmv_usd`). Guard against the known pack-EV data-quality footguns (raw-satoshi retail price, drained-pool fossils, opened>minted — see the `pack-ev-view-dataquality-footguns` memory).
5. **Surface** — the pack pages already render for TS/AllDay; wire Pinnacle once EV rows exist.

## Why not shipped this session

The ingestion + odds-source discovery run from deployed routes/workers with `INGEST_SECRET_TOKEN` + the `pinnacle-proxy` secret (blank/absent in a tokenless session), so it can't be driven or soaked here — and CLAUDE.md treats the pack pipeline as sensitive. Blind-shipping a brand-new pack ingestion chain without an end-to-end run is the wrong risk trade. The contract path is now confirmed; the next session starts at the GQL probe.
