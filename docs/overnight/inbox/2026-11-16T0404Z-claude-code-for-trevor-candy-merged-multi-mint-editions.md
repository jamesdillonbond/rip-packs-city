# Claude Code → Trevor: 90 Candy editions merge DIFFERENT cards (42,592 holdings) — re-key needs your go

> ✅ **ACTED ON 2026-11-15 ~8:41 PM PT** (Trevor: "you need to handle 2026-11-16T0404Z first"). Shipped `79c7bcece` + migration `20261116043431` — see the ledger entry "#259 shipped". The design changed from the proposal below after a 180-card probe: most merged cards' RIGHT editions already exist (they carried another card's metadata from a shared fetch, or lost a date), so the census re-reads each card once from its own metadata and moves it; only true collisions get `-n<size>`, and the majority card keeps the key (no URL churn, no deletes). Watch: the re-measure SQL below falls toward 0 over ~one census walk cycle.

**Filed:** 2026-11-15 ~8:05 PM PT (Claude Code cloud, autonomous pass). **Not changed at filing** — this is a re-key of live editions (URLs, sales, listings, FMV history move), the same scale as the 11-09 1-of-1 re-key, so it waits for a decision. Register: known-issues #259.

## What is wrong

`wallet_moments_cache` holds **3,857 Candy cards whose serial is ABOVE their edition's `circulation_count`**, in **90 editions holding 42,592 cards** (measured 2026-11-15 ~7:50 PM PT, after the serial fill `afc5b4c9a` landed). That is the same tell chain-strategy.md (2026-11-09) names for the 1-of-1 merge ("a held count above the circulation"), now on MULTI-mint editions. Magic Eden (via pg_net) shows each sampled edition holds more than one real card:

| edition key | cards inside (Magic Eden names) | mechanism |
|---|---|---|
| `c:2021-play-of-the-day:mlb-play-of-the-day-10` (circ 650) | "MLB Play of the Day 10/12/21 (2/650)", "MLB Play of the Day 10/26/21 (3632/3640)" | **code bug**: `baseName()` strips "(N/M)", then its `#?\d+/\d+$` fallback ALSO strips the date's "26/21" → every October game is one edition |
| `c:2024-mlb-all-star-commemorative-helmet:2024-mlb-allstar` (circ 797) | on-chain name "2024 MLB AllStar 10" for BOTH; JSON name "… Helmet - American League (1454/1454)" | the on-chain name carries no league; only the off-chain JSON name / denominator separates AL from NL |
| `c:batman-2025-1:batman-2025-core` (circ 289) | "Batman (2025-) #1 (1/1000)", "(1000/1000)" | same cut name + rarity across printings/covers; the edition kept one printing's size |
| 2022 tickets (8 editions, e.g. `new-york-yankees-at`) | names cut at 32 chars | different games share the cut prefix |

~70 of the 90 are DC titles (`<title>-<rarity>` keys), the rest MLB (tickets, Play of the Day, Players of the Month, Icon Chasers, Helmet, Fresh Threads, Gems).

## What it costs

Each merged edition publishes ONE price, ONE holder list, ONE circulation and ONE sales history for 2+ different cards: an AL Helmet /1454 and an NL Helmet /797 share a floor; a 10/12 and a 10/26 Play of the Day share an FMV. The trophies view is already guarded (1/1 only); FMV, edition pages, binder and market are not.

## Proposed fix (not applied)

1. **Key = cut name + rarity + DENOMINATOR** for prefixed (non-Base) sets — `…:<slug>-<rarity>-n<M>` — only where the denominator is known; it separates every case above except two cards with the same cut name AND the same size (measure after step 2).
2. Fix `baseName()` so the fallback `#?\d+/\d+$` strip runs only when no "(N/M)" suffix was stripped (dates survive).
3. Re-key through the existing 11-09 machinery: census REUSE must refuse an edition whose key is not the card's computed key (as it does for 1/1s), REPOINT moves holdings and listings, `candy_edition_key_aliases` maps old → new where exactly one successor exists (URLs 308; >1 successor = no redirect, like the 1/1 rule), sales re-attribute by mint, emptied editions deleted once unheld (a DELETE — needs your approval).
4. A guard: `serial_number > circulation_count` count on Candy (`v_edition_integrity_flags` arm), so a new merge is visible the day it starts.

**Why not tonight:** steps 1–3 move ~42k holdings and change public URLs; 11-09's re-key took four follow-ups (aliases, orphan deletes, listings repoint, 404 successors). Say "go" and the next session ships it in that order with a watch.

## Re-measure

```sql
select count(distinct w.edition_key) editions, count(*) cards_over
from wallet_moments_cache w join editions e on e.external_id=w.edition_key and e.collection_id=w.collection_id
where w.collection_id='209ade70-32c5-4470-bc7c-4793d660f713' and e.circulation_count is not null
  and w.serial_number > e.circulation_count;
```
