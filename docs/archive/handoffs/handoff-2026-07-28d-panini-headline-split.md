# Handoff — 2026-07-28 (round 4) · surface the Panini honest headline

## Context

Trevor delegated the Panini coverage ruling. **I made the call and shipped the DB half.** This is the UI half — one file, and the board renders identically until you do it.

Migration `audit_20260728_panini_squeeze_coverage_weighted_totals`, live and verified:

- `panini_squeeze_board` gains `coverage_flag` (appended last).
- `panini_squeeze_totals` gains `editions_hc`, `sealed_fmv_exposure_usd_hc`, `sealed_copies_hc`, `pct_sealed_usd_from_biased_sets` (appended last).
- **Purely additive** — every pre-existing column keeps its name, position and value. `app/insights/panini-squeeze/page.tsx:74` works unchanged.

Post-state verified: `security_invoker=on` on both, `anon` SELECT **false** on both, `authenticated` false, `service_role` true, `check_public_security_invariants()` **0**, board **3,774 rows with 0 unflagged**, trust health 0 breaches. All three migration traps found today were applied deliberately — reloptions restated, append-only, anon re-revoked.

## The ruling, and why

The board publishes one sealed-dollar figure. Today:

| figure | value |
|---|---|
| blended `sealed_fmv_exposure_usd` | **$1,636,380** (3,764 editions) |
| honest `sealed_fmv_exposure_usd_hc` (broad + partial) | **$644,215** (2,144 editions) |
| `pct_sealed_usd_from_biased_sets` | **60.6%** |

Three-fifths of the headline comes from `heavily_biased` sets — 36.5% of editions, ~40% checklist completeness, HIGH confidence on only 30% of rows, against 99% for `broad`. This is the same survivor-bias shape as the 2026-07-16 chase-biased pack pools, and RPC already set the precedent there: **publish the honest em-dash, not the confident wrong number.**

⚠ **Do not describe `coverage_flag` to users as "coverage."** It is derived entirely from `for_sale_count / pulled_count` — a market ratio used as a proxy for listing-driven discovery bias. It correlates with real completeness on the subset where that's measurable, but it is a bias-risk indicator, not a coverage measurement. "Listing bias" or "sample breadth" is honest; "coverage" is not.

## 13. Lead with the honest number

**File:** `app/insights/panini-squeeze/page.tsx` (+ `PaniniSqueezeClient.tsx` if the totals render there)

1. **Headline** → `sealed_fmv_exposure_usd_hc` / `editions_hc`, labelled as the lower-bias subset.
2. **Secondary** → the blended `sealed_fmv_exposure_usd` as an "all sets incl. high-bias" line, not the hero number.
3. **Methodology note** → one sentence using `pct_sealed_usd_from_biased_sets`, e.g. *"60.6% of all-sets sealed exposure comes from sets whose discovery is listing-biased; the headline excludes them."*
4. **Per-row badge** → `coverage_flag` on the table, so a reader can see which band any row belongs to. Add it to the two PostgREST select lists.

Both select lists already need touching for `coverage_flag`; the totals columns come back automatically if the query selects `*`, otherwise add the four names.

**Verification:** `npx tsc --noEmit` clean, deploy READY, board still gated (`/insights/panini-squeeze` 302s to `/login` under `credentials:'omit'` — verify with `res.url`, not `res.status`), headline reads $644,215 rather than $1,636,380.

**Revert:** revert the commit; the DB columns are additive and harmless if unread.

## Guardrails

Unchanged. Plus the two earned today: restate `security_invoker` on every `CREATE OR REPLACE VIEW` and re-`REVOKE` anon on any newly created view; and never assert a gate from an authenticated browser or an unchecked `res.status`.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

`/insights/panini-squeeze` leads with $644,215 across 2,144 lower-bias editions, shows the blended figure as a clearly-labelled secondary, carries a one-line methodology note quoting 60.6%, and badges each row with its bias band — with the board still gated and `PANINI_PUBLIC` still `false`.
