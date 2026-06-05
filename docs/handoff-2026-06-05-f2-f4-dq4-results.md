# Results — F2 + F4 shipped, DQ4 deferred (2026-06-05, Claude Code)

Executed [docs/handoff-2026-06-05-f2-f4-dq4.md](handoff-2026-06-05-f2-f4-dq4.md). FMV-thread only, direct to `main`. Two of three shipped + verified live; DQ4's "minimal" fix is not implementable as written and a naive version regresses pack-EV — deferred with a full writeup below.

## F2 — edition_offers ASK fallback — SHIPPED + VERIFIED (`d881a75`, deploy `dpl_6z3CHdSbHp1sL6Ki9Pfa7SsnR3p7` READY)

Cohort/comparable estimation stayed dead (confirmed). Built the ASK fallback instead.

New **Step 5c** in [app/api/fmv-recalc/route.ts](../app/api/fmv-recalc/route.ts): zero-sales TS editions stuck `NO_DATA` despite a live ask in `edition_offers.low_ask` now read honest `ASK_ONLY` at `low_ask × 0.90`.
- Why neither existing step reached them: Step 5 needs no snapshot (`fs IS NULL`); these carry a NO_DATA snapshot. Step 5b needs sales (`JOIN sales`); these have none. Step 5/5b only read `badge_editions.low_ask`, which doesn't cover this set. `edition_offers` is the near-complete TS ask feed.
- Scope guards: zero-sales only (any edition with a sale heals to a better sales-based label via Step 5b); same `≤ $10,000` ceiling as the badge path (3 absurd >$10k asks stay honest NO_DATA); `<> ULTIMATE`, `<> Pinnacle`.

**Live result** (05:28 cron tick, first run on the new code):
- `ask_offers_fallback = 477` (matched the pre-ship validation count exactly).
- Zero-sales NO_DATA-with-ask tail: 480 → **0**.
- Canonical TS NO_DATA tail: 582 → **105** (honest no-market remainder: no ask, or above-ceiling ask).
- Canonical TS `ASK_ONLY`: +477 (→ 970).
- `v_fmv_sanity_flags`: **0 rows** (no regression).

**All Day = no-op.** Its `edition_offers` rows (282) carry the bid side (`highest_offer`); `low_ask` is entirely unpopulated (the OffersV2 indexer fills bids, not asks). Nothing to convert. Sized first, as instructed.

Revert: `git revert d881a75` (snapshots self-heal on the next sweep).

## F4 — shared FMV basis renderer + methodology-linked chip — SHIPPED (`fd61038`)

Consolidated into ONE renderer in [components/entity/_shared.tsx](../components/entity/_shared.tsx):
- `fmvBasisText()` (pure, server-safe) + `<FmvBasis>` — one honest basis line: `"12 sales (30d)"` / `"12 sales (30d) · ask $45"` / `"ask-only $45"` / `"no sale in 30d"` / `"no market data yet"`.
- `ConfidencePill` gains optional `href` (default `/legal/fmv-methodology`) so a LOW/ASK_ONLY/STALE chip is one click from the explainer. Full-card tiles (grid, team checklist) pass `href={null}` to avoid an invalid nested `<a>`.

Wired the **edition detail KPIs** (canonical FMV surface) to show pill + basis.

Scope notes (honest boundaries, not omissions):
- **Moment page** already renders its own basis line (`· N sales / 30d`) — swapping in the shared pill risks a visual regression on a major public page for marginal copy alignment; left as-is.
- **Grid / team tiles** don't carry `sales_count_30d` / `ask` on their payload — a basis line there needs an API/RPC change, which is out of a pure-presentation pass. The pill renders consistently (non-linked inside the card).
- Dashboard / share tiles: not touched this pass (same payload-shape question; lower priority per the handoff).

Pure display, no pricing logic. Revert: `git revert fd61038`.

## DQ4 — DEFERRED (handoff premise not implementable; naive fix regresses pack-EV)

**Goal:** stop `seed_topshot_editions` re-minting inert UUID-keyed TS editions (~570/hr currently).

**Why the handoff's fix can't be done as written** ("make `seed_topshot_editions` prefer the integer pair, fetching `set.flowId`/`play.flowID` via the proxy"):
1. `seed_topshot_editions` is a **SQL function** — no proxy access, can't fetch GQL.
2. A pure-DB UUID→integer translation is blocked: `sets` maps set-UUID→`set_id_onchain` (244/258), but there is **no `plays` table** — play-UUID→`play_id_onchain` only exists transiently in the GQL the edge function fetches. So SQL alone cannot canonicalize the pair.
3. The real keying lives in the **edge function** `supabase/functions/compute-topshot-pack-ev/index.ts`: `seenExternalIds` (line ~873) and the pool builder (line ~1053) both key on the **UUID pair** (`set.id:play.id`). **All 35,821 TS `pack_drop_pool` rows are UUID-keyed (0 integer).** `get_topshot_editions_by_setplay` resolves a UUID-pair key only via literal-match to an inert UUID row — canonical integer editions are unreachable through this path.

**Why a naive DB-side skip is wrong:** making `seed_topshot_editions` skip UUID-format ids stops the leak but, because the pool resolves through those exact UUID rows, drops ~274 pool editions/run → **186 → fewer pool rows, degrading pack EV**. That's a pack-EV semantic regression, not a clean no-op.

**The correct fix** is to re-key the pack-EV edge flow to canonical integer editions: add `flowId`/`flowID` to the `EDITIONS_QUERY` node selection (or reuse the already-working `searchEditions` hydration that fetches them), prefer the integer pair at *both* `seenExternalIds` and the pool builder, and let `pack_drop_pool.edition_flow_id` become integer-keyed (it's internal — nothing outside pack-ev reads it; the only other `edition_flow_id` reference is All Day's `upsert_allday_marketplace_fmv`). This **improves** pack EV (pool resolves to real-FMV canonical editions) AND stops the leak. But it:
- touches the sensitive pack-EV pipeline (v11→v19, carefully budgeted),
- is an **edge function** (separate deploy; can't be smoke-verified from a daytime CC session without the INGEST token to trigger + watch the next run), and
- carries a 422 risk if `packEditionsV3.edition.set` doesn't expose `flowId` (unverifiable here).

**Mitigating context:** the leak is already **bounded** by the DQ2 UUID-dupe resolver shipped yesterday (`8e35190`) — total UUID rows hold ~1,400 (drained, not unbounded). The inert rows are trigger-gated (no canonical corruption); impact is cosmetic drift in `v_edition_integrity_flags`.

**Recommendation:** do the edge re-key as a dedicated task with the INGEST token in hand — deploy, manually trigger `compute-topshot-pack-ev`, confirm `gql_errors=0` + `pool_rows_written` stable in `pipeline_runs`, then one-time re-drain the residual. Shipping it blind from this session was the wrong risk.

## Verification queries

```sql
-- F2: zero-sales NO_DATA-with-ask tail should stay ~0; ASK_ONLY held up
WITH latest AS (SELECT DISTINCT ON (edition_id) edition_id, confidence FROM fmv_snapshots ORDER BY edition_id, computed_at DESC)
SELECT count(*) FILTER (WHERE confidence='ASK_ONLY') ask_only,
       count(*) FILTER (WHERE confidence='NO_DATA') no_data
FROM latest l JOIN editions e ON e.id=l.edition_id
WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id ~ '^[0-9]+:[0-9]+$';

-- DQ4 accumulation (still live until the edge re-key lands):
SELECT count(*) FROM editions
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id !~ '^[0-9]+:[0-9]+$' AND created_at > now() - interval '6 hours';
```
