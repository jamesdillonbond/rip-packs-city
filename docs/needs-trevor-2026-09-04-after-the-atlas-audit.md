# Needs Trevor — after the 2026-09-04 Atlas audit

Five things. The product call in §1 is now **made and shipped** — it is recorded here rather than removed, so the reasoning survives. The rest are FYI or structural.

## 1. ~~`#104 / 284` vs Top Shot's `#104/249`~~ — ✅ DECIDED AND SHIPPED (2026-09-04, migrations `20260904145331` · `20260904145452`)

I left this open because it looked like a preference between two defensible numbers. It wasn't — once the Atlas refresh gave a per-printing mint for **every** edition, it became an arithmetic check, and the arithmetic is one-sided:

> Across the **9,473** Top Shot base editions with an Atlas number, 8,161 agree with the stored value exactly; **1,312 differ, and every one differs by EXACTLY the sum of its own parallels' mints. Zero unexplained rows.**

So the stored value was the all-printings total and Atlas's is the printing's own mint, and option **(a)** — base row = the Standard printing's own mint — is the one the data supports. It is also the one we had already been reaching for by hand: `topshot_normalize_circulation` already subtracted parallel mints from base counts ("Base Set … n % 100 = 99 → n − 99" is the Club Collection /99 being removed), as a heuristic limited to series 8 and a hardcoded set list because no per-parallel count existed. This **completes that design with measured data** rather than replacing it, and the heuristic stays as the fallback for the ~33 % of editions Atlas hasn't walked.

**The rule now: `editions.circulation_count` is this printing's own mint** — the number Top Shot displays. Sabonis `227:7574` is **249**, and the ladder reads **249 / 25 / 9** and sums to the chain's 284 instead of double-counting it. The post-burn number is not lost; `badge_editions.effective_supply` carries it per printing.

**The parallel half was the worse defect and I nearly missed it.** 3,346 of 3,795 parallels already matched Atlas, but 449 did not: **`98:3150::5` stored 1,500 against an actual mint of 25**, and a family of Club Collection `::16` rows carried their *base* edition's total (`258:8988::16` 3,987 → 99). **38 parallels were overstated by 10x or more.** Others undercounted from observed holders (`273:9056::19` 19 → 25). A parallel is the scarcest thing you own; those were the worst numbers on the page.

**Corrected: 1,312 base + 449 parallel editions, carrying 186,124 holder rows.** Both correctors converged to 0. The fix lives in the `editions` BEFORE trigger — every writer passes through it, so nothing can flap — plus an hourly bounded sync at `:47` that is a no-op now that it has drained. Every old value is in `audit_20260904_base_circulation_sync` if you want it back.

**Nothing needed from you here anymore** — flagged only so you know the number changed and why.

## 2. Two dead upstreams are now routed around, not repaired

- `public-api.nbatopshot.com` (username resolution) — decommissioned. Nine routes now read the 9,370-name cache first; a name nobody has ever resolved gets an honest 503 telling the collector to paste the 0x address. **A brand-new username still cannot be resolved anywhere.**
- Top Shot GraphQL behind `badge-sync` — 530 on every tick since 08-28. Replaced by Dapper's Atlas API over pg_net. The old route is untouched and would resume if that host ever returns; if it doesn't, `app/api/badge-sync` and its two GitHub workflows are now dead weight worth deleting.

## 3. jobid 55 (`allday-pack-opens-backfill`) is unscheduled

It hadn't reached the edge function since 02:16Z — 25 of 25 ticks died at pg_net's 90 s wall — and because pg_net answers a batch when its slowest member finishes, it was **delaying every other pg_net request on the platform by up to 90 s a tick**. AllDay is sunset and the walk still had ~19 M blocks (~96 days). Backup + revert in `audit_20260904_jobid55_watchlist_retire_backup`. The forward job is untouched. Say the word if you want the deep history anyway.

## 4. Cosmetic mismatches I left alone (not defects)

`set_name` differs on 1,709 Moments ("Rookie Debut6" vs "Rookie Debut"); team naming on 43 ("Los Angeles Clippers" vs "LA Clippers"); All Day's edition ids are a different namespace from Atlas's (a constant offset, not a mis-map); RPC's All Day player names are populated where Atlas's are empty — we're *better* there. Locked state differs on 1,253 Moments because our lock flag refreshes on a slower cadence than Atlas's live one.

## 5. Unchanged structural items

#22 defeated credential purge · #58 `OPENSEA_API_KEY` · the alerting secrets.
