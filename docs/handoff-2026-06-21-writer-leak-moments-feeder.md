# RPC Claude Code — the TS sales mis-attribution WRITER is not fully fixed: the `moments` feeder still leaks (2026-06-21, post-f796447)

**Phase 1 of `docs/handoff-2026-06-21-sales-misattribution-fix-cc-prompt.md` is deployed but INCOMPLETE.** `f796447` ("GQL fallback resolves canonical int-pair edition, not UUID-dupe") is live and READY (deployed ~16:xx UTC, current prod is `d240fb8`). It correctly fixed Step 4d. But the forward writer is **still landing TS sales on inert UUID-dupe editions after the deploy** — so the conflation/mis-attribution source is not closed. The data cleanup is fully wired (see "Containment"), so nothing is corrupting long-term; this handoff is to **stop the source** so the daily drain isn't perpetually mopping.

## Measured post-deploy (read-only, Cowork)
`ts_sales_on_uuid` (TS sales whose edition `external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`) went **0 → 57** since CC's drain, **all 57 ingested in the last 2 hours**, in two paths:
- **23 `source='topshot_gql'`** — today's sales, the forward sales-indexer GQL path, ingested 17:00–17:59 UTC = **after f796447 deployed (~16:xx)**.
- **`source=NULL`** — `scripts/flow-backfill.ts`, a stateful historical TS-sales backfill (tracked by `flow_backfill_progress`; not in CI → externally scheduled, ~every 2h). **Re-measured cumulatively 2026-06-21: this is HEALTHY, not a leak** — 63,144 sales spanning 2020-07-28 → 2026-06-13, **99.9% on canonical editions** (only **56** on UUID-inert), **0 duplicate groups**, all with real prices (avg $27.69). The forward edge transiently lands a few untracked/new-play moments on UUID editions per batch (my first pass only counted that 0.1% tail and over-alarmed), but the cumulative residual is just 56 and the daily drain mops it. **Do NOT pause it — it's the valuable historical sales spine.** Optional low-priority refinement only: extend the same `/api/ingest` canonical guard to this script so the ~0.1% untracked tail resolves to int-pair at insert instead of cycling UUID→drain, and stamp a synthetic `transaction_hash` for dedup safety on any re-run. No urgency; the night pass should not alarm on a non-zero `source=NULL` UUID count.

### Root cause of the 23 forward leaks (data-proven — this is the new finding)
For the 23 `topshot_gql` UUID-edition sales (last 6h):
- `no_moment_row` = **0** → every one is present in the `moments` table.
- `moment_on_uuid_edition` = **15** → the `moments` row itself points at a UUID-dupe edition.
- `moment_on_canonical` = **8** → moment is on canonical, but the SALE diverged onto a UUID edition.
- `have_wmc_truth` = **0**, `canonical_edition_exists` = **0** → all 23 are **untracked-wallet** moments with no `wmc` truth and no canonical int-pair edition in the DB.

So the dominant leak (15/23) is the **`moments`-table feeder**: `app/api/sales-indexer/route.ts` resolves `nft_id → edition` from `moments` (≈ line 377) **before** the fixed Step 4d GQL fallback ever runs. Because `moments` still contains canonically-wrong UUID-keyed rows (~1,200), the indexer trusts them and Step 4d never fires. CC's `f796447` commit said "the moments hydrator already did int-pair + stub — no change needed"; the data disproves that — UUID-keyed `moments` rows are still being created and trusted.

## Fix (CC — hot-path ingest, can't ship from Cowork/MCP)
1. **Indexer moments-trust guard** (`app/api/sales-indexer/route.ts`, the moments lookup ~line 377): when the resolved moment's edition `external_id` is **not** canonical (`!~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`), do NOT trust it — fall through to the on-chain int-pair resolution that Step 4d now uses (`getMintedMoment` → `set.flowId`:`play.flowID` → `ensure_topshot_edition_stub`). Never write a sale onto a UUID-format edition.
2. **Moments hydrator** (`workers/topshot-moments-hydrator/`): same guard — never write/keep a `moments` row pointing at a UUID-dupe edition; resolve to the int-pair edition (+ stub) instead. This is Phase 1 item 6, still open.
3. **The 8/23 secondary path** (moment-on-canonical but sale-on-UUID): trace why the sale diverged from its own (correct) moment row — likely Step 4d producing/UUID-matching when `getMintedMoment` returns null on-chain ids (the ~line 475 "GQL missing on-chain ids" branch). On that branch, do NOT fall back to any UUID edition — leave the sale to the on-chain drain (write to `unmapped_sales` or skip), never an inert UUID row.

## Containment (already wired — verify, don't rebuild)
- **On-chain drain** `/api/admin/drain-topshot-misattribution?rekey=1` — Vercel cron `0 11 * * *` (`d240fb8`, READY). Its target set (`topshot_misattrib_drain_targets()`) explicitly includes UUID-edition sales, and it re-keys **sales + moments** via `getMintedMoment` → `remap_topshot_from_onchain_map()`. This reaches the untracked (no-wmc) leaks — i.e. it cleans the 57. Daily.
- **DB self-healer** pg_cron `rpc-remap-misattributed-sales` (`23 */6 * * *`, jobid 7) — re-keys the **wmc-resolvable** transients every 6h (these 57 are no-wmc, so the drain, not this, cleans them).
- **Guard** `topshot_conflated_editions` (17) suppresses the affected editions from the deal board / underpriced-serials / premium boards meanwhile. So the leak is inert + suppressed; the only cost is the drain perpetually mopping ~28/h forward + the history-backfill trickle.

## Verify after the fix
Re-run the by-source probe — expect 0 on both:
```sql
SELECT s.source, count(*) AS n
FROM sales s JOIN editions e ON e.id=s.edition_id
WHERE s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e.external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  AND s.ingested_at > now()-interval '2 hours'
GROUP BY s.source;
```
And the moments-feeder check: new `topshot_gql` sales should have `moment_on_uuid_edition = 0`. Guard `topshot_conflated_editions` trends to 0 and HOLDS (it currently re-accrues from this leak).

Guardrails: direct-to-main, PowerShell git, `git rev-list --count origin/main..HEAD` = 0, tsc clean; after any change `check_public_security_invariants()` = [], `check_secdef_anon_execute_violations()` = [], trust-health 9/9. The PAT lacks `workflow` scope — don't touch `.github/workflows/`. Update CLAUDE.md + `docs/overnight/ledger.md`.
