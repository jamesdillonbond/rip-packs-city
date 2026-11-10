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

## ↳ 10:15 AM PT — CORRECTION to "reading 1", and the decision (Trevor: "Do what you think is best")

**Decision: keep the last known price and show it as stale.** It matches how wallets already treat an old price and it does not zero anyone's moment.

**But the fix is not a re-label of the cache, as written above — that was wrong.** The readers do not use `wallet_moments_cache.fmv_confidence` when the edition has a row in `edition_fmv_current`; they take the CURRENT label and fall back to the CACHED price:

- `get_wallet_summary` (md5 `268b8e82…`): `COALESCE(lf.fmv_usd, wmc.fmv_usd)` and `COALESCE(lf.confidence, wmc.fmv_confidence)`. For a withdrawn edition `lf.fmv_usd` is NULL and `lf.confidence` is `NO_DATA`, so the moment carries its withdrawn price under the label `NO_DATA` — not `STALE` — and stays in the headline.
- `get_wallet_collection_stats` (md5 `5cc5e0ec…`): label from the newest snapshot (`NO_DATA`), summed under `IS DISTINCT FROM 'STALE'`.

Proved on the most affected All Day wallet: 33 moments, $16,559.69 of withdrawn prices, all inside `wallet_fmv` ($234,451.88) and none inside `stale_fmv` ($154,047.64) — about a fifth of that collector's headline ($80,404).

**So the change is in the READERS, and there are five that each define the stale split on their own:** `get_wallet_summary`, `get_wallet_collection_stats`, `get_wallet_collection_snapshot` (`bc7d6341…`), `get_collection_breakdown` (`a56d4756…`), `aggregate_saved_wallet_stats` (`426b8e69…`). The rule each needs: *a moment whose edition has a current row with a NULL price, and whose cached price is not NULL, is STALE.* An edition that never had a price (cached price NULL) must NOT become stale — it would inflate `stale_count`.

## Why it was not shipped this session

- Five full-body rewrites of the wallet-total readers, through a SQL editor, at the end of a long session, with another session having edited `get_wallet_summary` today (its body carries a 2026-11-10 note). Changing two of the five would make the dashboard, the Collection tab, the public profile and the daily snapshot disagree about one wallet — worse than the defect.
- It wants its own test: for a sample of wallets, `headline_after = headline_before − withdrawn` and `stale_after = stale_before + withdrawn`, with `total` and every unaffected wallet byte-identical.

## Proposed shape for whoever picks it up (Claude Code, one migration)

One SQL helper that all five call, so the rule lives once: e.g. `wallet_moment_confidence(lf_has_row boolean, lf_fmv numeric, lf_conf fmv_confidence, wmc_fmv numeric, wmc_conf fmv_confidence) RETURNS fmv_confidence` = `CASE WHEN lf_has_row AND lf_fmv IS NULL AND wmc_fmv IS NOT NULL THEN 'STALE' ELSE COALESCE(lf_conf, wmc_conf) END` (IMMUTABLE, so it inlines). `get_wallet_collection_stats` reads the newest snapshot directly and needs the price beside the label. Acceptance: the 474-row / 79-wallet / $89,860 figure above moves from headline to stale and nothing else moves.

## ↳ ✅ CLOSED — applied by another session at 10:14 AM PT as `20261110181426`; verified independently 10:50 AM PT

A Claude Code session picked this filing up and put the rule in all five readers (commit `72d7a75`). Found when a second, staged copy of the same fix failed its own pre-check: all five `md5(prosrc)` had moved. That copy was discarded, not applied.

Independent check on the three most affected All Day wallets, `get_wallet_summary` against a separate sum of (current STALE) + (withdrawn rule): stale $170,607.33 = $170,607.33 (was $154,047.64, +$16,559.69, count 365 → 398 = +33), $19,371.37 = $19,371.37, $17,753.37 = $17,753.37; `wallet_fmv` unchanged on each. A one-statement check across all affected wallets timed out at the tool's limit and was not completed.
