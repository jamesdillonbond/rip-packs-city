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

## Phase 1 — green-lit (Trevor 2026-06-20). Keying scheme + the full predicate enumeration.

**Keying scheme — DECIDED: additive hybrid on the EXISTING `::` convention.** Discovery found the codebase
already threads a parallel/subedition dimension through the market/display layer with a **double-colon** key:
`buildMarketScopeKey` ([lib/market-scope.ts]) returns `editionKey::parallel`; [lib/topshot-graphql.ts] and
[app/api/sniper-feed/route.ts] do `editionKey.split("::")[0]`; sniper-feed already tests
`^\d+:\d+(::\d+)?$`. And `PARALLEL_IDS` ([lib/topshot-badges.ts]) — `Hexwave:19, Jukebox:20, Hardcourt:18,
Blockchain:17` — **exactly matches the on-chain `subeditionID`**, i.e. GQL `parallelID` == on-chain
`subeditionID` == the planned `editions.subedition_id`. So:
- `editions.external_id = setID:playID::subeditionID` for subId>0 (DOUBLE colon, matching the existing
  convention); **Standard stays `setID:playID`** (the bulk, untouched), keeping the
  `wmc.edition_key == editions.external_id` join contract intact and the migration additive.
- Plus `subedition_id` (smallint) + `subedition_name` (text) on `editions` — **SHIPPED Phase 1a**
  (`audit_20260620_editions_add_subedition_columns`, nullable/unpopulated = no-op today).
- The canonical predicate widens to **`^[0-9]+:[0-9]+(::[0-9]+)?$`** (double colon, matching sniper-feed)
  everywhere it appears. 0 existing `::` editions today, so the widen is a verified no-op until Phase 2.

**Data sources (confirmed):** the per-moment subedition is `getMomentsSubedition(nftID)` / `getSubeditionByNFTID`
on-chain (authoritative for the per-nft sales/wmc remap); `badge_editions.parallel_id` is NOT usable (only 3
non-zero rows platform-wide). The 22-name catalog is `getAllSubeditions()`. GQL `searchEditions.parallelID`
is the catalog-writer source (matches the on-chain id).

### The predicate ripple — COMPLETE ENUMERATION (must widen `^[0-9]+:[0-9]+$` → `^[0-9]+:[0-9]+(::[0-9]+)?$`)
Fails by OMISSION (silently excludes subedition rows from FMV scans/insights/the detector) — invisible to
tsc/smoke; each site needs deliberate review. **Migrations under `supabase/migrations/` are frozen history —
do NOT edit; re-assert the predicate via a fresh CREATE OR REPLACE in Phase 2.**

Code — JS regex `/^\d+:\d+$/` (15): [lib/editions-hydrate.ts:475], [app/api/backfill-editions/route.ts:119]
(negation — keep UUID excluded), [app/api/cache-refresh/route.ts:421,441,444],
[app/api/wallet-search/route.ts:871,894,899], [app/api/market/route.ts:313,459],
[app/api/support-chat/route.ts:691], [app/api/ingest/route.ts:275,587], [app/api/edition-search/route.ts:15],
[app/api/cron/topshot-sales-history-backfill/route.ts:530]. (sniper-feed:1467 ALREADY widened — the template.)
Code — SQL `~ '^[0-9]+:[0-9]+'` strings: [app/api/sentinel/route.ts], [app/api/wallet-search/route.ts],
[app/api/cache-refresh/route.ts], [app/api/admin/backfill-badges-from-sets/route.ts],
[scripts/backfill-badges-from-sets.mjs], [scripts/backfill-badges-from-moments.mjs].
DB functions (12): `badge_editions_block_topshot_uuid_key`, `editions_block_topshot_uuid_dupe`,
`fill_topshot_set_play_from_external_id` (parses setID:playID — must take split_part on the FIRST two only),
`get_edition_parallels` (NOTE: a DIFFERENT notion — same play, *different set*; cross-set, not subedition —
leave as-is unless it should also span subeditions), `get_topshot_editions_by_setplay`,
`get_topshot_set_detail`, `get_topshot_set_progress`, `get_wallet_ipfs_pin_list`, `remap_pack_pool_uuid_key`,
`seed_topshot_editions` (the catalog writer — emit `::subId` for subId>0), `seed_topshot_sales_history_targets`,
`sentinel_fmv_confidence_canonical_ts`.
DB views (6): `topshot_perfect_mint_premiums_board`, `topshot_serial_premiums_board`,
`topshot_special_serial_owners`, `v_edition_integrity_flags`, `v_fmv_sanity_flags`, `v_rpc_trust_health`.
Docs to update: CLAUDE.md (schema-facts predicate), docs/cowork-skills/rpc-data/SKILL.md.

### Staged sequence (each phase verified read-only before the next — NO partial half-mapped re-key)
- **Phase 1a — SHIPPED:** additive `editions.subedition_id`/`subedition_name` columns (no-op).
- **Phase 1b — widen the predicate** at all sites above to `(::[0-9]+)?` + update CLAUDE.md/skill. No-op
  today (0 `::` rows); verify canonical-TS-edition counts unchanged after. Do as ONE reviewed sweep.
- **Phase 2 — catalog + remap (coordinated, the dangerous step):** create the per-subedition `editions` rows
  (external_id `::subId`, own circulation from `getNumberMintedPerSubedition`, subedition_id/name set);
  re-map each subedition moment's `sales`/`wmc`/`moments` by nft_id via `getMomentsSubedition`; flip the
  ingest write-path (wallet-backfill + sales→edition resolution + `seed_topshot_editions`) to call
  `getMomentsSubedition` and write the `::subId` key for subId>0 — **backfill rows FIRST, then flip ingest**,
  never a window where new sales split from historical. The residual `setID:playID` row becomes Standard-only.
- **Phase 3 — FMV per parallel:** recompute FMV per row (now clean per-subedition); the shipped `cd9d7b2`
  serial-normalization then applies cleanly WITHIN each parallel.

Phase 1b + Phase 2 are the multi-hour coordinated work — they touch ingest/wmc/fmv/badges/pack-EV/special-
serials and must not be rushed alongside other work. Recommend a dedicated session per phase.

## Surfaces a re-key will touch (inventory)
editions (external_id/key + per-subedition circulation_count), wmc.edition_key contract (must still equal
editions.external_id), sales.edition_id resolution at ingest, badge_editions join key, fmv_snapshots keying,
pack_drop_pool, special_serial owners MV, the catalog/ingest edition writer, app/api/ingest, wallet-backfill,
lib/chains/flow/* moment-data scripts, app/api/fmv-recalc + lib/fmv-confidence.
