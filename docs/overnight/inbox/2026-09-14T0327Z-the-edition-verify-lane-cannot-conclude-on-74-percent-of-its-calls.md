# The edition-verify lane cannot conclude on 74 % of its calls, and the fix is in the REQUEST, not the rate

*(Claude Code, cloud — 2026-09-13 8:2x PM PT. **Instrument SHIPPED; the fix is NOT.** Read-only investigation plus one additive migration.)*

## What was asked, and the answer

#85 left an explicit open question: **does `atlas_market_drain` re-observe still-open listings, or only report changes?** It gated two proposed levers — bulk ageing, and raising `atlas_listing_verify_dispatch`'s `p_max`.

**Answer: new-and-changed only. It does not re-observe.** Of **69,953** open `nba` listings whose `last_seen_at` moved in 24 h, **66,785 (95.5 %) were first seen in that same window**; only **3,168** were genuine re-observations of pre-existing rows. Against 371,310 open listings that is a **117-day** cycle. Over a 30-minute window the median re-seen row is **0.00 h** old (3,560 of 3,859 under five minutes).

`atlas_market_upsert_events` *does* bump `last_seen_at = now()` on conflict, so the column genuinely is a re-observation stamp — the feed simply never re-reports a quiet open listing.

⛔ **Therefore BULK AGEING MUST NOT SHIP.** "Not seen in 6 days ⇒ closed" would mark **live** listings closed on the sniper board — a fabricated fact, the exact defect class the honesty canon exists to prevent.
⛔ **And raising `p_max` on the listing-verify lane is the WRONG LEVER.** See below.
⚠ **My own 7:1x PM ledger entry ("verify queue 27× underwater") measured the wrong lane. Do not carry that framing forward.**

## The real finding

The honest bulk closer **already exists**. `atlas_edition_verify_settle` closes stale listings **per edition**, but only once a COMPLETE snapshot proves they are gone:

```
v_complete := v_total IS NOT NULL AND v_total <= 200;
IF v_complete THEN
  UPDATE ... SET completed = true
   WHERE ... AND NOT ev.completed AND ev.last_seen_at < q.dispatched_at;
```

That refusal is **correct** — closing on a partial fetch would fabricate a closure. And the leverage is large: the **305,123** stale-open listings sit in just **11,541 editions — 26.4 per edition** (max 140), so this lane closes ~26 listings per external call against the listing lane's **1**.

🚨 **But of 12,597 editions verified since 09-06, only 3,268 (25.9 %) came back `complete = true`. The other 9,329 (74.1 %) closed NOTHING.** Their `totalCount` exceeds the request's hardcoded `limit := 200`, and `atlas_edition_verify_dispatch` re-picks any edition whose `verified_at < now() - interval '24 hours'` — **so those 9,329 are re-probed every day, forever, and can never conclude.**

Live corroboration while writing this: eight consecutive ticks (8:12 → 8:26 PM PT) settled 2–6 editions each — **32 editions, `closed: 0` every time.**

## Why the fix is cheap

The request body is `jsonb_build_object('product','nba','editionId', …, 'limit', 200)` — **no `offset`, no open-only filter.**

⭐ **The API supports `offset`, and this repo already proves it:** `atlas_market_dispatch` sends `jsonb_build_object('product', p, 'limit', 200, 'offset', v_offset)`. So pagination needs no API discovery — only the same parameter the sibling lane already uses.

Two shapes, either of which converts ~9,329 **already-paid** daily calls into conclusive ones rather than buying new ones:

1. **Paginate past 200** for editions with `totalCount > 200`, and close only when every page returned 200. Costs `ceil(N/200)` calls **once per 24 h cycle** instead of 1 wasted call per cycle forever.
2. **Narrow the fetch** so `totalCount` falls under the limit — offers are roughly half of all events (**1,134,777** listings vs **1,065,243** offers), so a listings-only filter would drop many editions under 200 for free. ⚠ Unverified: whether the Atlas endpoint accepts such a filter. Establish that before costing this option.

## What shipped, and what deliberately did not

✅ **SHIPPED** — `supabase/migrations/20260914032500_audit_20260913_record_total_count_so_the_edition_verify_lanes_waste_is_an_instrument.sql`. Adds a nullable `total_count integer` to `topshot_atlas_edition_verified` and persists the `v_total` the settle already computes. **Behaviour unchanged**: no predicate, no closure rule, no dispatch selection touched, and nothing reads the column yet.

**Why it was worth a migration:** `complete = false` conflates *"too big to conclude"* (`totalCount > 200`) with *"no usable response"* (NULL). The 74.1 % above is currently an **inference**; this makes it a **reading**.

⏳ **NOT SHIPPED — the pagination fix itself.** It changes a live external lane's call volume, and it should be sized against the instrument rather than against my inference. It also wants a decision on option 2 first, since that could make option 1 much cheaper.

## Exit condition (falsifiable)

The column populates on the 24 h re-verify cycle — **0.03 % (4 of 12,613) ten minutes after apply**, so expect full coverage by ~2026-09-14 evening PT. Then:

```sql
SELECT count(*) FILTER (WHERE NOT complete AND total_count > 200)  AS too_big,
       count(*) FILTER (WHERE NOT complete AND total_count IS NULL) AS no_response,
       count(*) FILTER (WHERE complete)                             AS conclusive
  FROM public.topshot_atlas_edition_verified;
```

**If `too_big` is not ~9,329/day, this filing's central claim is wrong and should be rewritten, not patched.** ⚠ Note the 4 rows instrumented so far were all `complete = true` yet still closed 0 — a conclusive edition with nothing stale correctly closes nothing, so **`closed: 0` alone does not prove incompleteness.** That is precisely the conflation the new column resolves; do not read the tick logs as if it did.

## Method note worth keeping

The first probe returned a clean **zero** — because it filtered `product = 'topshot'` when the live vocabulary in this table is **`nba`** / `nfl`. Published as-is, that zero would have "proven" the feed never re-observes, which is the **opposite** of the truth. Discriminated before use. Every count here is `product = 'nba'`.
