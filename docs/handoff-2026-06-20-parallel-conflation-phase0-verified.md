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

## SHIPPED this session (interim guard + locked decision)

**Interim deal-alert suppression — LIVE (Trevor approved).** Conflated TS editions are excluded from the
deal board + alerts until the re-key lands.
- `audit_20260620_topshot_conflated_editions_interim_guard` — new `public.topshot_conflated_editions`
  (RLS on, anon/auth read-only, service_role writes) + SECDEF `refresh_topshot_conflated_editions()`
  (service_role only, 120s timeout): flags editions where 2+ distinct nft_ids share a serial over 365d.
  Populated **741** editions at ship.
- `audit_20260620_topshot_deals_exclude_conflated_editions` — `topshot_deals_vs_fmv` (the board's TS leg,
  also read by `dispatch_due_deal_alerts`) gains `AND NOT EXISTS (... topshot_conflated_editions ...)`.
  TS board 598 → 447 (**151 fake deals suppressed**); Traore 233:8121 gone. `security_invoker=on` + grants
  preserved; `check_public_security_invariants()`=0, `check_secdef_anon_execute_violations()`=[].
- `app/api/cron/refresh-conflated-editions` — 202+after Bearer-INGEST refresh route (mirrors
  refresh-special-serial-owners-mv). **Operator: wire a daily cron-job.org entry** (set is slow-moving;
  populated now, only misses newly-conflated editions until refreshed).
- **Revert:** restore the prior `topshot_deals_vs_fmv` body (drop the NOT EXISTS clause);
  `DROP FUNCTION public.refresh_topshot_conflated_editions(); DROP TABLE public.topshot_conflated_editions;`
  delete the cron route + entry.

**Keying scheme — DECIDED (Trevor delegated "best for RPC long term"): additive hybrid.**
`external_id = setID:playID:subeditionID` for subedition>0 (Standard stays `setID:playID`, keeping the
`wmc.edition_key == editions.external_id` join contract intact and the migration additive — only ~the
conflated minority get new rows) PLUS explicit `subedition_id` (smallint) + `subedition_name` (text) columns
on `editions` so the parallel is first-class/queryable for display, circulation, and the serial model. The
canonical int-pair pattern widens to `^[0-9]+:[0-9]+(:[0-9]+)?$`. This is the heavy Phase 1–3 work below —
staged, each phase verified read-only before the next; do NOT ship a partial half-mapped re-key.

## Remaining decision points for Trevor

1. **Scope/sequence sign-off** for Phases 1–3 with the decided keying scheme (identity change →
   catalog+remap by nft_id → FMV per parallel, then within-parallel serial-normalization) — staged, each
   verified read-only before the next, no partial half-mapped re-key. This is multi-day; needs Trevor to
   green-light starting Phase 1 (it touches ingest/wmc/fmv/badges/pack-EV/special-serials).

## Surfaces a re-key will touch (inventory)
editions (external_id/key + per-subedition circulation_count), wmc.edition_key contract (must still equal
editions.external_id), sales.edition_id resolution at ingest, badge_editions join key, fmv_snapshots keying,
pack_drop_pool, special_serial owners MV, the catalog/ingest edition writer, app/api/ingest, wallet-backfill,
lib/chains/flow/* moment-data scripts, app/api/fmv-recalc + lib/fmv-confidence.
