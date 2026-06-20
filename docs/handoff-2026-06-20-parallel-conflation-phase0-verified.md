# Phase 0 VERIFIED — TopShot SubEdition (parallel) conflation is the FMV root cause (2026-06-20)

Read-only on-chain verification of [docs/handoff-2026-06-20-fmv-parallel-conflation.md] (the handoff that
supersedes the serial-contamination framing). **Confirmed at the contract level + on the proven moments.**
No keying change shipped — this is the Phase-0 deliverable for Trevor's planning. Do NOT start a re-key
until the scheme is chosen (decision points at the bottom).

## What was proven (all read-only, Cadence MCP against mainnet + DB)

1. **Mechanism = TopShot SubEdition.** The deployed `TopShot` contract (`0x0b2a3299cc857e29`) mints
   parallels via `mintMomentWithSubedition(playID, subeditionID)`. Key facts from the source:
   - The subedition id is **NOT in `MomentData`** (which holds only `setID`, `playID`, `serialNumber`).
     It lives in a SEPARATE `SubeditionAdmin` resource, read via the contract-level views
     `getMomentsSubedition(nftID): UInt32?` and `getSubeditionByNFTID(nftID)`. **This is exactly why our
     wallet-backfill never captured it — it reads `moment.data`, where the field does not exist.**
   - Each subedition has its OWN serial sequence: `serialNumber: numInSubedition + 1`. So two subeditions
     of the same `setID:playID` BOTH contain a serial #1, #2, … #N. This is the duplicate-serial fingerprint.
   - `MomentMinted` event carries `subeditionID` (available at mint for the forward path).
   - MetadataViews exposes `"Subedition"` (default `"Standard"`) and `"SubeditionID"` (default `0`).
   - 22 named subeditions exist platform-wide: Vibe, Voltage, Diamond, Hexwave, Club Collection, Jukebox,
     Bit, Coded, Astra, Explosion, Hardcourt, Rippled, Blockchain, Omega, Vortex, Halftone, Diced, Bubbled,
     Torn, Championship, Livewire, Galactic. subeditionID `0`/absent = Standard.

2. **Proven on Nolan Traore "Metallic Gold LE" (edition `a6ec315c-91c0-4e17-a61b-27fd1935d0da`, external_id
   `233:8121`, RARE).** It is the only editions row for play 8121. Resolved every recently-traded nft_id
   on-chain:

   | Subedition | nft_ids (examples) | price range |
   |---|---|---|
   | **Standard** (0) | ~33 moments (5126xxxx, 5130xxxx) | ~$14–33, **median ~$23** |
   | **Hexwave** (19) | 51321012/14/**19**/29/30/33 | $16–62 |
   | **Jukebox** (20) | 51319354/57/**60**/61 | $52–88 |

   The two #9 moments the handoff names: **nft 51319360 (sold $61) = Jukebox**, **nft 51321019 (sold $39) =
   Hexwave** — same setID:playID 233:8121, same serial #9, DIFFERENT subedition. The $23 floor ask is a
   **Standard**; the recent low-serial sales that dragged the blended WAP to $45.83 (#9 $61, #6 $52, #3 $65,
   #10 $88) are all **Jukebox**. This is genuine conflation, **NOT a hydration mis-key** (on-chain truly
   shares setID:playID; the subedition is a real uncaptured dimension).

3. **Magnitude (floor): 676 of 8,569 recently-traded TS editions (~8%)** show the duplicate-serial signature
   (detector in the handoff, 180d window). Floor only — catches conflation where 2+ shared serials both
   traded in-window; the true count of any setID:playID hosting 2+ subeditions is higher. Concentrated in
   premium parallel sets (Metallic Gold LE etc.) where the inter-subedition price gap — and thus the FMV
   error and the fake-deal rate — is largest.

## Feasibility notes for Phases 1–2 (confirmed during Phase 0)

- **Per-nft resolver is batchable + deterministic.** `getMomentsSubedition(nftID)` / `getSubeditionByNFTID`
  resolved 44 ids in a single script. Subedition is fixed at mint, so a backfill keyed by nft_id is
  mechanical and idempotent. Production reads go through the proxy workers (CLAUDE.md); the Cadence MCP was
  used here for dev-time verification only.
- **Forward path:** the sales-indexer / wallet-backfill have nft_id in hand; resolve subedition at ingest
  (batched per tick) or read it off the `MomentMinted` event. The catalog/ingest that writes `editions` must
  emit one row per (set, play, subedition).
- **Standard moments (subedition 0) are the bulk** — keeping them on their existing `setID:playID` key makes
  the re-key ADDITIVE: create new rows only for subedition>0 and re-map their sales/wmc/moments by nft_id;
  the residual `setID:playID` row becomes Standard-only and its FMV self-corrects to ~$23 on the next recalc.
  Per-subedition circulation comes from `getNumberMintedPerSubedition`.

## Standing of the serial-contamination fix shipped earlier today (`cd9d7b2`)

`cd9d7b2` (serial-aware base FMV — exclude #1/perfect/jersey/low-serial premium from the base WAP) is the
**Phase 3, within-parallel** step from the serial-contamination handoff. It does NOT fix conflation; it
operates on the blended pool. For Traore it happens to land ~$23 (Standard dominates volume), but conflated
editions remain mispriced until parallels are split. It is a net-positive interim symptom-reducer for the
~92% NON-conflated editions (where it is exactly correct) — **kept, not reverted.** Order for the future:
split parallels (Phases 1–2) FIRST, then this serial-normalization applies cleanly within each parallel.

## Decision points for Trevor (BEFORE any keying change)

1. **Keying scheme.**
   - (A) `external_id = setID:playID:subeditionID` for subedition>0, Standard stays `setID:playID`.
     Least invasive (Standard = the bulk, unchanged; additive re-key); but the canonical int-pair pattern
     `^[0-9]+:[0-9]+$` (detector, sitemap, dupe-block trigger, fmv-recalc filters, wmc.edition_key contract)
     must widen to `^[0-9]+:[0-9]+(:[0-9]+)?$`.
   - (B) add a `subedition_id` column + composite unique `(collection_id, setID, playID, subedition_id)`.
     Cleaner relationally; heavier because every edition-keyed join contract currently uses `external_id`.
2. **Interim alert suppression.** Until parallels split, suppress deal alerts (and optionally deal-board
   rows) on detector-flagged editions so users stop seeing fake deals. Low-risk, reversible, does NOT touch
   identity/keying. Recommend ON as an interim guard.
3. **Scope/sequence sign-off** for Phases 1–3 (identity change → catalog+remap → FMV per parallel) — staged,
   each verified read-only before the next, no partial half-mapped re-key.

## Surfaces a re-key will touch (inventory)
editions (external_id/key + per-subedition circulation_count), wmc.edition_key contract (must still equal
editions.external_id), sales.edition_id resolution at ingest, badge_editions join key, fmv_snapshots keying,
pack_drop_pool, special_serial owners MV, the catalog/ingest edition writer, app/api/ingest, wallet-backfill,
lib/chains/flow/* moment-data scripts, app/api/fmv-recalc + lib/fmv-confidence.
