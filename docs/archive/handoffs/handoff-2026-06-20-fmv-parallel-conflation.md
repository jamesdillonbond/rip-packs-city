# RPC Claude Code handoff — FMV root cause is PARALLEL CONFLATION (setID:playID collapses multiple parallels into one edition) (2026-06-20)

Foundational data-model issue → REVIEWED, planned change (not a quick patch). Diagnosis below is measured. This SUPERSEDES the framing in handoff-2026-06-20-fmv-serial-contamination.md — serial-normalization is a real but SECONDARY refinement that applies WITHIN a parallel, AFTER parallels are split. Fix this first.

## What Trevor observed

Deal alert showed Nolan Traore "Metallic Gold LE" (MGLE) FMV $45.83 vs a $23 low ask — a fake "deal." Trevor's domain knowledge: the recent #6 that sold for $59 was a JUKEBOX parallel, not the standard parallel the $23 listing is for. And: "There can be the same serial amongst numerous parallels. There's probably a #6 serial for all 3 of Traore's MGLE parallels."

## Root cause (proven by data)

Top Shot issues a play in MULTIPLE PARALLELS (base + Jukebox + other LE printings) that SHARE the same setID:playID on-chain, distinguished by a parallel/subedition dimension RPC does not capture. We key editions by external_id = setID:playID, so every parallel collapses onto ONE editions row. Their sales merge into one FMV — blending a premium parallel's prices with the standard's.

Proven on Traore MGLE (edition_id a6ec315c-91c0-4e17-a61b-27fd1935d0da, external_id 233:8121, "Metallic Gold LE", RARE, circ 164):
- Only ONE editions row exists for play 8121 (external_id LIKE '%:8121' returns just 233:8121). "Jukebox" is not catalogued as a set at all. So the parallels Trevor names have no separate edition rows — they all resolve to 233:8121.
- Its recent sales contain DUPLICATE SERIALS on distinct moments — the conflation fingerprint. Serial #9 traded as nft 51319360 ($61) AND nft 51321019 ($39); 44 distinct moments traded but only 40 distinct serials → 4 serials each appear on 2+ moments. A single 164-circ edition has exactly one of each serial. wmc (on-chain-derived) labels BOTH #9 moments 233:8121, so on our setID:playID key they are indistinguishable.
- moments_exceed_circ = 0 and only 51 editions platform-wide have any serial > circulation — because parallels share the SAME serial range (each parallel is its own ~164-circ edition numbered 1..N). That's why this hid: combining parallels never overflows circ or produces an over-circ serial. The ONLY reliable detector is "same serial on 2+ distinct nft_ids within an edition."

## Magnitude (floor)

Using the duplicate-serial detector over the last 180 days of canonical TS sales: 676 of 8,569 recently-traded editions (~8%) show the conflation signature. This is a FLOOR — it only catches parallels where 2+ shared serials happened to BOTH trade within the window; the true count of conflated editions (any setID:playID hosting 2+ parallels) is higher. It is concentrated in premium parallel sets (Metallic Gold LE, etc.) where the price gap between parallels is largest — i.e. where the FMV error is biggest and most visible.

Detector query (CC can re-run / widen the window):
```sql
WITH ms AS (
  SELECT edition_id, serial_number, count(DISTINCT nft_id) AS nfts
  FROM sales WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND serial_number>0 AND nft_id IS NOT NULL AND sold_at > now()-interval '180 days'
  GROUP BY edition_id, serial_number)
SELECT count(DISTINCT ms.edition_id) AS editions,
  count(DISTINCT ms.edition_id) FILTER (WHERE ms.nfts>1) AS conflated
FROM ms JOIN editions e ON e.id=ms.edition_id WHERE e.external_id ~ '^[0-9]+:[0-9]+$';
```

## Why it matters beyond FMV

The edition is the unit of identity across the whole platform, so collapsing parallels corrupts more than FMV:
- FMV: blends parallels (worst on the high-value ones) → fake deals on the deal board + in alerts.
- circulation_count: one row's circ can't represent 3 parallels of different sizes.
- serial-premium / serial_fmv model: fits a serial curve over a mixed pool of parallels — garbage in.
- Pack EV: pull values keyed to a conflated edition.
- special-serial owners / special serials: a "#1" is really 3 different #1s (one per parallel).

## Fix — phased, on-chain-verified, REVIEWED

PHASE 0 — verify the on-chain mechanism FIRST (CC + Cadence MCP; do not infer from price clusters):
- Use the Cadence MCP to fetch the deployed TopShot contract + the moment-metadata path, and resolve the two conflated #9 moments (nft 51319360 and 51321019) plus a few other Traore MGLE moments via the TS moment-data script (through topshot-proxy for any live read). Confirm they return the SAME setID(233)/playID(8121) but DIFFER on a parallel/subedition/printing field. Identify the exact field name + type that distinguishes parallels (e.g. a subedition id, a "Set.parallel" index, or a play-level parallel attribute). This field is the missing key component.

PHASE 1 — extend edition identity to include the parallel dimension:
- Decide the canonical key: external_id = setID:playID:parallelId (keeps the text-key convention + the int-pair canonical filter would become a 3-part pattern), OR add a parallel_id column with a composite unique (collection_id, setID, playID, parallel_id). Whichever, update: editions (external_id/key), wmc.edition_key contract (must still equal editions.external_id), sales.edition_id resolution at ingest, badge_editions join key, fmv_snapshots keying, pack_drop_pool, special-serial owners. This is the heavy part — every edition-keyed surface.

PHASE 2 — catalog + re-map:
- Ingest the missing parallel editions (the catalog backfill that writes editions needs to emit one row per parallel using the Phase-0 field). Re-map existing sales/wmc to the correct parallel using each moment's on-chain parallel id keyed by nft_id (the moment's parallel is fixed at mint). Backfill is per-nft_id, so it's mechanical once Phase 0 gives the field.
- FASTER RE-MAP SOURCE (verify before relying on it): the marketplace transaction feed exposes the parallel label per sale. Trevor confirmed a populated PARALLEL column (Hexwave / Jukebox / standard) on the Traore recent-purchases view — Jukebox sold $46-73, standard ("--") $17-25, Hexwave #12 $17, all blended into one moment view, with the standard tier (~$23) matching the floor ask. So the subedition/parallel data exists UPSTREAM in the feed, not just on-chain. Check whether the Top Shot GQL `searchMarketplaceTransactions` / dapper.market transactions RPC already ingests carry the subedition/parallel field (we currently drop it — `sales` has no parallel column). If they do, that's a BATCHABLE bulk historical re-map source, with on-chain `getSubeditionByNFTID` (Phase 0) as the authoritative per-nft fallback/verification rather than the only path.

PHASE 3 — FMV per parallel, then serial premium within parallel:
- Recompute FMV per parallel (each now its own edition → clean WAP, lands near its own floor ask). THEN apply the within-parallel serial-premium normalization from handoff-2026-06-20-fmv-serial-contamination.md (exclude #1/jersey/perfect/low-serial premium sales from the base WAP; layer the serial premium via serial_fmv). Order matters: serial-normalization BEFORE splitting parallels would only mask the conflation, not fix it (a premium parallel's #100 still contaminates).

## Guardrails / caveats
- Big, foundational, multi-step — needs Trevor's planning + the Phase-0 on-chain verification BEFORE any keying change. Do NOT ship a partial re-key that half-maps moments (worse than the current honest-but-blended state). Stage it; verify each phase read-only before the next.
- This is reviewed pricing + identity logic. Until parallels are split, FMV-over-ask + fake deal alerts persist (~8%+ of editions) — treat deal alerts with skepticism meanwhile, or interim-suppress alerts on editions flagged by the duplicate-serial detector.
- Direct-to-main, PowerShell git, verify git rev-list --count origin/main..HEAD = 0; tsc clean. FMV writes delete-then-insert, collection_id NOT NULL. Cadence reads via the proxy workers only (CLAUDE.md), Cadence MCP for dev-time verification only.

## Files / surfaces likely touched
- Catalog/ingest that writes editions (topshot-catalog-backfill + the GQL/Cadence edition path) — emit one row per parallel.
- app/api/ingest (sale->edition resolution), wallet-backfill (wmc.edition_key), lib/chains/flow/* moment-data scripts.
- app/api/fmv-recalc + lib/fmv-confidence (per-parallel FMV).
- badge_editions, fmv_snapshots, pack_drop_pool, special-serial owners MV — all edition-keyed.
