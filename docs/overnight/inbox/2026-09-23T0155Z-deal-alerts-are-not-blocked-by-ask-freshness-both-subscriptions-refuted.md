# Deal alerts are NOT blocked by ask freshness — both subscriptions refuted, and the proposed Atlas widening buys nothing

*(Claude Code, Windows box, ~6:00 PM PT 2026-09-22. **READ-ONLY — nothing shipped, no subscription edited.** Trevor's subscription data is his to change.)*

## What was filed, and why it is wrong

The 2026-09-22 daytime handoff, item 1: *"Deal alerts are nearly unable to fire on Top Shot… The gate is correct (an ask must be confirmed within 12 h), but only 1,485 of 13,154 Top Shot asks (11 %) are that fresh… The choice is widening Top Shot ask confirmation (more Atlas coverage) or accepting that alerts only cover about 11 % of editions."*

The 11 % is real (re-derived: **1,770 of 13,160**, median `updated_at` age **127.6 h**). **The conclusion does not follow.** Neither active subscription is blocked by it, so widening Atlas coverage — the one option with an infra cost, against a "no infra spend pre-revenue" constraint — would deliver **zero** additional alerts.

## Subscription 2 — "Blazers rookie special serials 25 %+ under FMV" — the gate holds back NOTHING

`serial_only: true`, so it scans the SERIAL pool, and `dispatch_due_deal_alerts` reports the pools separately. Every tick for hours:

```
enqueued_deal 0 · unconfirmed_deal 64 · unconfirmed_price ~2,480 · unconfirmed_serial 0
```

⚠ **`unconfirmed_serial: 0` is ambiguous from outside and must be checked** — `count(*) FILTER (WHERE NOT alertable)` over an EMPTY pool is also 0, and the route logs the unconfirmed counts but **not `serial_pool_size`**, which the RPC does return. Measured directly:

| `topshot_underpriced_serials_board` | |
|---|---|
| rows | 39 |
| `estimate_quality='tight'` AND `ask_usd>0` (the pool) | **17** |
| of those, `ask_is_alertable('nba_top_shot', last_seen_at)` | **17 of 17** |
| ≥25 % discount | 12 |

So the pool is not empty and the freshness gate is a genuine **no-op** on this arm — exactly as `audit_20260912`'s header predicted ("serial board: 16 rows, all `last_seen_at` within 1.6 h → 16"). None of the 17 is a Portland Trail Blazers rookie-badge moment. **This is an honest market zero**: the pool is ~17 rows estate-wide and the filter is (team = Blazers) AND (one of 4 rookie badges) AND (≥25 % under FMV).

## Subscription 1 — "Damian Lillard Archive ≤ $0.60" — blocked by its OWN filter, by 83×

The price pool IS gated (2,480 rows held back). It does not matter, because the subscription cannot match anything at any freshness:

| `edition_current_ask`, player ILIKE Damian Lillard | |
|---|---|
| editions with an ask | 65 |
| cheapest ask | **$0.20** |
| editions ≤ $0.60 | **14** |
| …of those, in a set named "Archive" | **0** |
| editions in an "Archive" set at any price | **1**, asking **$50.00** |

`set_names` matching is CONTAINMENT, deliberately ("Archive" must match "Archive Set" — the function says so in a comment), so the subscription is well-formed. There is simply one Lillard Archive edition and it asks $50 against a $0.60 cap.

⭐ **Drop the `set_names: ["Archive"]` filter and it fires today.** Of the 14 Lillard editions ≤ $0.60, **2 are alertable right now**: Base Set $0.20 (ask confirmed 14:11 PT) and Base Set $0.24 (13:31 PT).

## Control: would a fresher ask source even help?

`ts_listings` (Atlas-fed, pg_cron 466) is a rolling 24 h book — 34,253 listings, 2,800 distinct editions, 14,444 rows ingested within 12 h. Joined to `edition_offers` **on the parallel-aware key**:

| | |
|---|---|
| editions with both an ask and a `ts_listings` row | 2,971 |
| `ts_listings` seen within 12 h | 1,779 |
| `edition_offers.updated_at` within 12 h (today's gate) | 1,770 |
| **newly alertable if the gate also accepted `ts_listings`** | **356** |
| floors disagreeing by >$0.01 | **12 of 2,971** — all `ts_listings` DEARER, **0 cheaper** |

⛔ **My first pass said 1,241 newly-alertable and 1,409 disagreements. Both were wrong**: that join grouped `ts_listings` by `set_id:play_id` alone, merging every parallel into its base — the exact trap `b22eedbed` fixed the same day. **Key Top Shot editions as `setID:playID` plus `::parallel` when `parallel_id <> 0`.**

The corrected numbers say the incumbent floors are **old but not wrong**, and that no cheap deal is being hidden by staleness (0 editions where a fresher source shows a LOWER ask).

## What this does and does not license

- ⛔ **Do not buy more Atlas coverage to fix deal alerts.** It is the one costly option and it addresses a cause that is not operating on either subscription.
- ⭐ The real repair for the *marker* remains known-issues **#98** — a Top Shot *checked* stamp (`topshot_atlas_edition_verified.verified_at` plumbed into `edition_offers`). ⚠ But note that table wraps slowly too: **13,485 rows, only 556 (4 %) verified within 12 h**, oldest 09-14 — and its `atlas_edition_id` does **not** join to `edition_offers.external_id` as-is. #98 is a real fix for what the stamp MEANS; it is not a fix for coverage.
- The actionable item is a **product** one for Trevor: subscription 1's set filter. Not edited here — it is his data.

## Falsifier

Remove `set_names` from subscription `fd0d7a2c-3a31-4d94-9c91-0db7af2f697d` and the next `alerts-dispatch` tick should enqueue ≥1 delivery. If it does not, this filing is wrong and the price-pool gate matters after all.
