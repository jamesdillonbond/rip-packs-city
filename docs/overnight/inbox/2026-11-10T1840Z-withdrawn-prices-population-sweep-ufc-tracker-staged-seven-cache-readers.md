# Withdrawn prices — the population sweep that closes the thread: one tracker fix staged (UFC, latent), seven readers of the cached price left as a recorded choice, everything else read clean

Filed 2026-11-10 ~10:40 AM PT by Cowork cloud (platform audit pass, closing round). Follows `2026-11-10T1715Z` (All Day set tracker, fixed `20261110173413`) and `2026-11-10T1800Z` (wallet totals, fixed `20261110181426`). Nothing was changed in production by this filing.

"Withdrawn" = `edition_fmv_current.fmv_usd IS NULL` while an older `fmv_snapshots` row has a price. Population at 10:30 AM PT: All Day 196 editions ($78,407.10), Top Shot 88 ($38,410.40), Golazos 29 ($203.01), UFC 0 of 45 NULL rows, Candy 0. Panini (own table, `panini_fmv_snapshots`): 274 latest-NULL, 156 with an older price.

## The sweep

Every `public` function whose body takes a price from `fmv_snapshots … fmv_usd IS NOT NULL … ORDER BY computed_at DESC` (14), plus every function reading `wallet_moments_cache.fmv_usd` (40), was listed from `pg_proc`; the ones the "not examined" lists of the two earlier filings named were read.

| reader | shape | result |
|---|---|---|
| `get_team_checklist*`, `get_player_checklist*` ("cost to finish") | newest snapshot, **no** non-null filter | **clean** — a withdrawn edition reads unpriced |
| `get_platform_stats` (coverage %) | newest snapshot, `confidence <> 'NO_DATA'` | **clean** |
| `analytics_fmv_tier_pulse` | newest snapshot inside 24 h | **clean** — the withdrawal row is the newest |
| `get_allday_market_editions_v4`, `get_golazos_market_editions_v2`, `get_topshot_sniper_deals_v3` | latest NON-NULL inside 90 days | **clean by population, not by code**: called wide open, 0 withdrawn editions among 4,486 / 495 / 5,000 returned rows. An edition with a live listing prices as ask-only, so it is never withdrawn. The shape would resurrect a price only if a listed edition could be NO_DATA. |
| Panini collector views (`panini_profile_holdings`, `panini_holdings_breakdown`, `panini_collection_export`) | `edition_fmv_current` | **clean**; no Panini view or function reads a non-null-filtered snapshot |
| `get_wallet_moments_with_fmv` (binder rows) | newest snapshot, no filter | **clean** — the row shows no price |
| `get_ufc_set_progress` | latest NON-NULL, whole collection | **latent** — see below |
| seven readers of the cached price | `wallet_moments_cache.fmv_usd` as a plain price | **recorded choice** — see below |

## 1. UFC set tracker — fix staged, not applied

Same CTE the All Day tracker carried. Equivalent today over the whole UFC population: old CTE 572 priced editions / $18,647.80, `edition_fmv_current` 572 / $18,647.80, 0 differing — so no number is wrong now, and none would change. The first withdrawal of a once-priced UFC edition would put its old price back into "cost to complete".

`docs/proposals/audit_20261110_ufc_set_tracker_reads_current_fmv_cache-STAGED.sql` — guarded on `md5(prosrc) = eb19eb47…`, rewrites from the live body, asserts the ACL. `apply_migration` was refused for this session (the fifth refusal today); it was **not** routed through the dashboard editor, since nothing is wrong on the page today. Baselines to compare after applying (`md5(get_ufc_set_progress(wallet)::text)` on the three largest UFC wallets by cached moments, 1,571 / 304 / 276): `6c838139…`, `c6164083…`, `a5d896aa…` — all three must be unchanged.

To apply: move the file to `supabase/migrations/<version>_audit_20261110_ufc_set_tracker_reads_current_fmv_cache.sql` and run it through `apply_migration` (Claude Code) or the SQL editor.

## 2. Seven readers show the cached last-known price with no stale mark

`20261110181426` put the stale rule in the five readers that split a wallet total into headline and stale. These read `wallet_moments_cache.fmv_usd` directly and have no stale split at all, so a withdrawn price appears as an ordinary price:

`get_user_top_owned_moments` (trophy picker ranking), `get_user_hero_moment` (profile hero), `export_wallet_csv`, `concierge_wallet_breakdown`, `get_wallet_tc_report`, `get_wallet_total_fmv`, `snapshot_all_user_portfolios` (daily portfolio history).

Measured 10:35 AM PT: 492 cached moments / $93,506.96 across 77 wallets carry a withdrawn price; among wallets saved by a signed-up user, **8 moments / $442.01 across 4 wallets**.

This is consistent with the decision taken at 10:15 AM PT (keep the last known price, call it stale): these seven already sum prices the engine labels STALE without marking them, so a withdrawn price is treated like any other old price there. It leaves one visible seam: the binder ROW for such a moment shows no price while the wallet's stale line and these seven readers still count its last known one. Closing that seam is the other reading of the decision ("a withdrawn price is no price"): clear the cached price and teach the four cache writers to carry a NULL. Not done — it changes what 77 collectors see, and it is a decision, not a repair.

## Not examined

`holdings_summary` (latest non-null from `fmv_snapshots_2026`) has no caller in `app/`, `lib/`, `components/` or `supabase/functions/`; not traced further.
