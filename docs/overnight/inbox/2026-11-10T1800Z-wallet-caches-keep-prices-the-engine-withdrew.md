# Wallet caches keep prices the engine has withdrawn — $89,860 across 474 moments in 79 wallets; no writer can carry a NULL

Filed 2026-11-10 ~10:00 AM PT by Cowork cloud (platform audit pass). Read-only finding; nothing was changed. Follows `2026-11-10T1715Z` (the All Day set tracker, fixed as `20261110173413`).

## What was read (9:50 AM PT)

An edition is "withdrawn" here when `edition_fmv_current.fmv_usd IS NULL` and an older `fmv_snapshots` row has a price — the newest snapshot is a `cold-tail-1.0` / `NO_DATA` NULL written 11-03 → 11-10.

| collection | withdrawn editions | their stale prices | `wallet_moments_cache` rows on them | still priced | value still in wallets | wallets |
|---|---|---|---|---|---|---|
| NFL All Day | 196 | $78,407.10 | 432 | **432** | $69,987.17 | 48 |
| NBA Top Shot | 88–89 | $38,410.40 | 42 | **42** | $19,872.62 | 31 |
| Panini | 70 | $76,889.48 (one of $10,000) | 0 (own tables) | — | — | — |
| LaLiga Golazos | 29 | $203.01 | 0 | — | — | — |
| UFC, Candy | 0 | — | — | — | — | — |

**Every one of the 474 cached rows is still priced — a perfect correlation, which names a missing path rather than a lag.** By the cached confidence label: All Day ASK_ONLY 146 ($38,430.59), STALE 112 ($24,464.40), **LOW 174 ($7,092.18)**; Top Shot ASK_ONLY 24 ($18,961.62), STALE 18 ($911.00).

## Why (read from `prosrc`, not run)

Every writer of `wallet_moments_cache.fmv_usd` takes the latest NON-NULL snapshot, so a withdrawal is invisible to all of them:

- `refresh_wmc_fmv_changed` (cron) builds its change set from `fmv_snapshots … WHERE computed_at > v_cutoff AND fmv_usd IS NOT NULL` — a NULL snapshot never enters it.
- `backfill_wmc_fmv_confidence` (cron) and `populate_wmc_fmv_from_snapshots`: `… WHERE fmv_usd IS NOT NULL ORDER BY computed_at DESC LIMIT 1`.
- `resync_stuck_wmc_fmv` (cron) reads `edition_fmv_current … WHERE l.fmv_usd IS NOT NULL`.
- `holdings_summary` reads the latest non-null from `fmv_snapshots_2026` ("No computed_at age filter, deliberately (May 7 fix)").

## The decision this needs before any code

The wallet surfaces already have a home for an old price: the "+ $X across N stale-priced" line beside Wallet FMV. So there are two defensible readings of a withdrawn price in a wallet:

1. **Keep the last known price, labelled stale.** Then the defect is only the LABEL: 174 All Day rows marked LOW ($7,092) and 170 marked ASK_ONLY ($57,392) should read STALE so they leave the headline and join the stale line. A small lane that re-labels cached rows whose edition's current price is NULL does it; the four writers need no change to their price logic, only to stop re-stamping the old label.
2. **A withdrawn price is no price** (what the edition page, the boards and now the All Day set tracker do). Then the cached price must be cleared, and all four writers must learn to carry a NULL — otherwise the next tick of `backfill_wmc_fmv_confidence` puts the old price back.

Reading 1 is the smaller change and matches how wallets treat stale prices today. Reading 2 is consistent with every other surface. Not chosen here: it changes what 79 collectors see as their collection value.

## Not touched, and why

- `refresh_wmc_fmv_changed` is the platform's largest writer, and another session edited `resync_stuck_wmc_fmv` today (a "2026-11-10: lock" note is in its body). A second session rewriting the same family the same morning is the collision CLAUDE.md warns about.
- Same shape, not examined: `get_ufc_set_progress` (0 withdrawn editions today, so no wrong number now), `analytics_fmv_tier_pulse`, `get_platform_stats`, and the `fmv` lateral inside `get_team_checklist*` / `get_player_checklist*` ("cost to finish").
- Panini's 70 withdrawn editions ($76,889) live in Panini's own tables; whether its collector views keep them was not read.
