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
