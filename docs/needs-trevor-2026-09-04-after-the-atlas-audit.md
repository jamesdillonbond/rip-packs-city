# Needs Trevor — after the 2026-09-04 Atlas audit

Five things. One is a product call I deliberately did not make; the rest are FYI or structural.

## 1. `#104 / 284` vs Top Shot's `#104/249` — a real product call (the only decision I owe you)

RPC shows Sabonis `227:7574` as **#104 / 284**. Top Shot shows the same Moment as **#104/249**.

Both numbers are correct for different questions, which is why I stopped rather than picking:

- The chain's `getNumMomentsInEdition(set, play)` returns **every printing together**: 249 Standard + 25 Hexwave + 10 Jukebox = **284**. `topshot-circulation-onchain` (Claude Code shipped it this morning) writes that faithfully, and I confirmed on four editions that `editions.circulation_count` equals the sum of the printings every time.
- Top Shot's own display is the **Standard printing's** mint, 249.

The visible consequence: the moment page's parallel ladder reads "Standard / 284 · Hexwave / 25 · Jukebox / 9" — the 284 already contains the 25 and the 9, so the ladder double-counts, and any collector cross-checking against Top Shot sees a denominator that doesn't match.

**Why I didn't just change it:** the column is owned by a pipeline that shipped hours before I looked, and the denominator feeds serial rarity and FMV serial multipliers across many surfaces. Two clean options:

- **(a)** base row = the Standard printing's own mint (249); the ladder then sums to the chain total. Truest to what a collector sees on Top Shot.
- **(b)** keep the chain total and relabel that ladder row "All printings" (or show both).

Either way **the data is already there and fresh**: Atlas's per-printing `numMinted` now lands in `badge_editions.circulation_count` every ~2.5 h.

## 2. Two dead upstreams are now routed around, not repaired

- `public-api.nbatopshot.com` (username resolution) — decommissioned. Nine routes now read the 9,370-name cache first; a name nobody has ever resolved gets an honest 503 telling the collector to paste the 0x address. **A brand-new username still cannot be resolved anywhere.**
- Top Shot GraphQL behind `badge-sync` — 530 on every tick since 08-28. Replaced by Dapper's Atlas API over pg_net. The old route is untouched and would resume if that host ever returns; if it doesn't, `app/api/badge-sync` and its two GitHub workflows are now dead weight worth deleting.

## 3. jobid 55 (`allday-pack-opens-backfill`) is unscheduled

It hadn't reached the edge function since 02:16Z — 25 of 25 ticks died at pg_net's 90 s wall — and because pg_net answers a batch when its slowest member finishes, it was **delaying every other pg_net request on the platform by up to 90 s a tick**. AllDay is sunset and the walk still had ~19 M blocks (~96 days). Backup + revert in `audit_20260904_jobid55_watchlist_retire_backup`. The forward job is untouched. Say the word if you want the deep history anyway.

## 4. Cosmetic mismatches I left alone (not defects)

`set_name` differs on 1,709 Moments ("Rookie Debut6" vs "Rookie Debut"); team naming on 43 ("Los Angeles Clippers" vs "LA Clippers"); All Day's edition ids are a different namespace from Atlas's (a constant offset, not a mis-map); RPC's All Day player names are populated where Atlas's are empty — we're *better* there. Locked state differs on 1,253 Moments because our lock flag refreshes on a slower cadence than Atlas's live one.

## 5. Unchanged structural items

#22 defeated credential purge · #58 `OPENSEA_API_KEY` · the alerting secrets.
