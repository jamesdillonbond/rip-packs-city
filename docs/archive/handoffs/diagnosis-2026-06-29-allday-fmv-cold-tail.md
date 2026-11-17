# Diagnosis + proposal — NFL All Day FMV cold tail (2026-06-29, Cowork, read-only)

Per the cross-thread request: profile the AllDay FMV cold tail (NO_DATA + STALE) and decide if it can be ask-floored ASK_ONLY (like the TS parallel floor). **Pricing pipeline is review-gated and a concurrent session is actively writing AllDay cold-tail FMV right now — so this is diagnosis + proposal only. Nothing shipped.**

## Coordination flag (important): a live pipeline already owns this

There is an **actively-running `drain-fmv-cold-tail` pipeline** (algo_version `cold-tail-1.0`) firing **every 30 min (:17/:47)**, multi-collection, `threshold_days=7`. Its recent AllDay ticks write STALE/NO_DATA (and a little ASK_ONLY/SALES_ONLY). It is the latest writer for 59 of the 63 ask-bearing cold editions below. **Do not ship a competing AllDay cold-tail writer — coordinate with that session.** CC's `refresh_allday_ask_fmv_from_listings` (`allday-listing-ask-v1`, daily) is the other cold-tail writer.

## Profile (latest FMV per edition, AllDay, 2026-06-29)

HIGH 256 · MEDIUM 655 · SALES_ONLY 60 · LOW 2,252 · ASK_ONLY 1,208 · **STALE 345 · NO_DATA 1,415** → cold tail = **1,760**.

**The core answer: the cold tail is ~96% genuinely zero-liquidity.** Of 1,760 cold editions, only **63 (3.6%) have a live ask in ANY indexed source** (`cached_listings_v2` AND `allday_edition_floor_ask` — the same 63). The other **1,697 (96.4%) have no live ask anywhere** — no sales, no listing. These are *honest* NO_DATA/STALE, exactly like the Top Shot NO_DATA "troll-ask"/zero-liquidity tail. **They cannot be ask-floored because no ask exists** — fabricating ASK_ONLY for them would be inventing a price. Per the TS precedent, do NOT auto-ASK_ONLY zero-sale/zero-ask editions; this is a data-quality reality, not a coverage bug. (The 18% HIGH+MED vs TS 26% gap is thinner AllDay liquidity, not a fixable miss.)

## The only actionable sliver: 63 ask-bearing cold editions

These have a live `cached_listings_v2` ask (all listed >7 days) yet read NO_DATA/STALE. Root cause is a **two-writer ordering interaction**, not a missing source:
- CC's `refresh_allday_ask_fmv_from_listings` floors STALE/NO_DATA → ASK_ONLY (low_ask×0.90) from `cached_listings_v2`. It ran once today (17:05, rescued 521). **None of the 63 got an ask-floor snapshot today** (`had_ask_floor_today = 0`) — at 17:05 they weren't yet cold, and the daily floor hasn't re-run.
- The 30-min `drain-fmv-cold-tail` (`cold-tail-1.0`) re-labels them STALE/NO_DATA **without flooring from their live ask**, so it wins the "latest" race and they stay cold.

## Proposal (for the `drain-fmv-cold-tail` owner — review-gated, not shipped here)

1. **Accept the 1,697 zero-liquidity editions as honest NO_DATA/STALE.** No action — there is no ask to floor them with. (Matches the TS lesson: coverage is a liquidity fact, the lever is quality not fabricated asks.)
2. **Fold the ask-floor INTO the cold-tail drain** so the two writers stop racing: before `drain-fmv-cold-tail` labels an edition STALE/NO_DATA, check for a live floor and emit ASK_ONLY (×0.90) instead. That makes the cold-tail pass internally consistent and removes the dependence on a separate daily floor run catching the same editions. Recovers the 63 (and keeps recovering as the drain runs every 30 min vs the floor's daily cadence).
3. **Prefer `allday_edition_floor_ask` as the floor source** (3,977 editions with a per-edition floor, purpose-built) with `cached_listings_v2` as the fallback — richer than `cached_listings_v2` alone.
4. Either way, a single unified cold-tail+ask pass is cleaner than two writers; if kept separate, run the ask-floor *after* the drain (or on the same cadence) so the drain can't clobber the floor.

## Net
AllDay cold-tail FMV is already near its honest ceiling — ~96% of NO_DATA/STALE is genuine zero-liquidity, and the 63-edition recoverable sliver is a writer-ordering fix owned by the live `drain-fmv-cold-tail` session, not a new build. The higher-leverage AllDay FMV work (sales-driven HIGH/MED) is gated on liquidity, not on this tail.
