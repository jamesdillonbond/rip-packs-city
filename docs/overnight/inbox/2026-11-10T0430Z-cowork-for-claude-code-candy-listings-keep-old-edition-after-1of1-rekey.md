# Cowork → Claude Code: retired `candy_listings` rows keep the OLD edition after a Candy 1/1 is re-keyed, so the orphan cleanup can never remove those editions

**Filed:** 2026-11-09 ~8:30 PM PT by Cowork cloud. **Owner:** Candy census / listings (`c30913392` re-key, `app/api/candy-listings-indexer/route.ts`). **Severity:** LOW (no user-visible defect; blocks cleanup and leaves listing history on a dead edition).

## Measured
- `candy-orphan-one-of-one-editions` first tick (8:22 PM PT): candidates 30, deleted 19, **referenced 11**.
- All 11 are `candy_listings` rows (`is_active = false`, `venue = magic_eden`, `last_seen_at` 7:35 PM PT) whose `edition_id` is the card's OLD name-keyed edition (e.g. `gold26:aaron-judge-legendary`) while `wallet_moments_cache` already keys the same `token_mint` as `gold26:aaron-judge-legendary-8iGGRQDyBaFh`.
- `candy-listings-indexer` resolves `edition_id` by mint only for asks Magic Eden returns this sweep; a retired ask is never re-upserted, so its edition never moves. Every future 1/1 re-key with past listings repeats this.

## What would close it
1. When the census repoints a card to its per-card edition, repoint `candy_listings.edition_id` by `token_mint` in the same step (the OpenSea indexer `candy-opensea-listings-indexer` writes `edition_id` too — same rule).
2. Or: in `candy_delete_orphan_one_of_one_editions`, before deleting, move `candy_listings` rows to the card's current edition by `token_mint` (full-body function change + pin update).
3. One-off for today's 11: an UPDATE by `token_mint` → wmc `edition_key` → `editions.id`, guarded to editions that are unheld Candy 1/1s — drafted in the Cowork session, awaiting Trevor's approval.

## ✅ RESOLVED 2026-11-09 ~9:00 PM PT (Claude Code cloud) — option 1, durable for both re-key paths

- **Shipped:** `candy_repoint_listings_to_card_edition(p_mints)` (migration `20261110044500`, pinned in `supabase/tests/candy_repoint_listings_to_card_edition.sql`): every `candy_listings` row for a mint — Magic Eden and OpenSea, active or retired — moves to the edition the card's NEWEST `wallet_moments_cache` row names. The census calls it once per page right after it repoints cards (`45bae3819`; `listings_repointed` in the run log; an error fails the page so it is re-read). That covers both the 1/1 re-key (`c30913392`) and the name-only repoint (`28720979f`).
- **Today's 11:** already moved one-off (`bb11953c5`); at 8:55 PM PT 0 of 8,301 listings differed from their card's edition.
- **Also shipped:** `candy_delete_orphan_name_only_editions` (same migration, hourly `:37`) — the sibling cleanup for the 4,844 name-only editions; it skips any edition a listing still names.
