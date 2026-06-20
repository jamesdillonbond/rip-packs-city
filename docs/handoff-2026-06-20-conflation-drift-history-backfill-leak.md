# RPC Claude Code handoff — the rising-conflation Phase-4 blocker is the history backfill (not the forward path) (2026-06-20)

Read-only diagnosis (Cowork). Resolves WHY conflation is drifting up (46 and rising) instead of converging to 0 — which is the only thing blocking Phase 4 (removing the four interim conflation guards).

## Finding (measured)
The rise is caused entirely by ONE sale source: **`ts_history_backfill_v1`** (the `topshot-sales-history-backfill` GHA pipeline draining the 9,091-edition queue). Of all parallel-moment sales currently stranded on a BASE edition instead of their `::` subedition edition:
- 73 / 73 are `source='ts_history_backfill_v1'`, ALL ingested in the last 24h, latest `sold_at` = 2026-06-07 (i.e. it's ingesting OLD parallel sales now and keying them to the base).
- 0 are from `onchain`, `offer_fill`, or `topshot_marketplace` — so the FORWARD path (Stage A `buildEditionKey` appending `::parallelID`) is working correctly for live sales. Only the history backfill is subedition-unaware.

Mechanism: when the history backfill ingests a sale of a parallel moment, it resolves the edition as `setID:playID` (the base) and does NOT append `::subID`. Each such insert re-creates a dup-serial on the base edition → conflation ticks up. Because the queue is large and still draining, conflation will keep rising until this path is fixed — so Phase 4 can never be reached, and a one-time re-remap alone would just be overwritten by the next backfill batch.

## Fix (CC) — make the history-backfill ingest subedition-aware
Mirror the forward `buildEditionKey` `::` logic on the history-backfill insert path: when ingesting a sale whose `nft_id` is a known parallel, key it to `setID:playID::subID`, not the base.
- Cleanest lookup: `topshot_moment_subeditions` is fully populated (247,129 nfts; `subedition_id > 0` = parallel). At ingest, look up `nft_id → subedition_id`; if `> 0`, target the `::` edition (`base || '::' || subedition_id`), which already exists for all flagged bases.
- For an nft not in that table (a parallel not yet resolved), optionally call the on-chain `getMomentsSubedition(nftID)` (same path Stage B used) before keying; otherwise it lands on the base and gets swept by the periodic re-remap below.

## One-time cleanup (clears the current residual)
Re-run the standard remap UPDATE on the 73 currently-stranded sales (all have an existing `::` target — verified: target_subedition_exists = 73, catalog_gap = 0). The same nft_id→`::`-edition UPDATE used in Stage B clears them. After the source fix, this is a one-time mop-up rather than a recurring fight.

## Result / Phase-4 unblock
With (a) the history-backfill path subedition-aware and (b) the one-time cleanup, conflation converges to ~0 and STAYS there (no new leak). That meets the documented Phase-4 teardown gate ("conflation → ~0 stable"), at which point remove the four `topshot_conflated_editions` interim guards (deal board + underpriced-serials suppression, serial-premiums + perfect-mint `is_conflated` caveat) per docs/handoff-2026-06-20-conflation-exposure-public-boards.md and the ledger revert paths.

## Verify after the fix
Re-run this session's diagnostic — expect 0 stranded from `ts_history_backfill_v1` on new ingests, and `SELECT count(*) FROM topshot_conflated_editions` trending to ~0 and holding across a few backfill batches:
```sql
SELECT s.source, count(*) AS stranded_on_base
FROM sales s
JOIN topshot_moment_subeditions ms ON ms.nft_id = s.nft_id AND ms.subedition_id > 0
JOIN editions e ON e.id = s.edition_id AND e.external_id NOT LIKE '%::%'
WHERE s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
GROUP BY s.source;
```

Guardrails: direct-to-main, PowerShell git, rev-list 0, tsc clean. The ingest-keying change touches a write path — verify trust-health 9/9 + security invariants 0 after, and confirm the forward path still keys correctly (no regression for live sales).
