# 2026-09-04 (morning PT) — The 200-Moment Atlas audit, and the four pricing defects it found · Cowork (desktop VM)

**Ask (Trevor):** "…use chrome to do additional QA across the site … audit 200 different Top Shot and NFL All Day Moments in my collection, comparing what we show on RPC vs what is available on V2 Top Shot and/or Dapper Market pages." Preceded by the full health check + "keep going, don't stop until you've exhausted everything."

> ⚠ Scope line: this session pushed normally (persisted device-flow cred, fresh `$HOME/rpcwork` clone). A Claude Code session shipped concurrently on Trevor's box all pass; the ledger was re-spliced into upstream with `scripts/resolve-ledger-rebase-conflict.mjs` on the one conflict.

## What the audit actually was

Not 200 hand-compared pages. Dapper's own backend — `api.production.atlas.dapperlabs.com`, the one `nbatopshot.com` itself calls — answers `NFTService/SearchNftsByOwner` **unauthenticated from a browser**. So the whole wallet came across: **all 15,183 Top Shot + all 3,707 NFL All Day Moments** (serial, tier, parallel, minted / burned / effective supply, locked, badges, low ask, highest offer, average sale), diffed against `wallet_moments_cache` + `editions` + `edition_fmv_current` + `badge_editions`.

**Identity is sound.** All Day: 0 rows differ on either side. Top Shot: agrees to 3 Moments out of 15,183 (plus 38 pre-parallel-split fossils with a null `edition_key`). Nothing is missing and nothing is invented. What the diff exposed is **pricing and completeness**, and all four are now closed.

| # | defect | measured | fixed by |
|---|---|---|---|
| 1 | Every Top Shot ask / offer / avg sale / badge / supply number **frozen since 08-28 15:16Z** — the badge-sync GraphQL host answers 530 on every tick | 1,431 editions with a stale ask (LeBron `5:133`: stored $16, actual $1,950); 92 Moments with badges on Top Shot and none here; **0 parallel rows in the whole table** | `20260904063544` — pg_net dispatcher + drainer onto Atlas `SearchEditions` |
| 2 | 67,607 wmc rows across **285 wallets** were a parallel priced as its Standard (a Jukebox /9 valued as a /284) | 1,264 of the founder's 1,447 parallels; the daily split re-keyed ~1,000/day and `upsert_wmc_batch` put the base key straight back on every re-walk | `20260904062632` — parallel resolved at write time + a self-retiring one-shot (67,530 re-keyed) |
| 3 | The FMV drain is lossy — wmc disagrees with the edition's current price | 1,369/15,175 founder rows and 15,027/160,209 across the other 20 saved wallets; 4,464 of them >5% off | `20260904055844` — per-saved-wallet reconcile, `6,36 * * * *` |
| 4 | `topshot_atlas_edition_map` mapped 1,497 of 9,080 editions to the **wrong printing** | 44 of 274 live Underpriced-#1s rows were a parallel's #1 priced against the Standard's FMV | `20260904055030` — parallel-exact join |

**Then the re-run**, which is the part that matters: `wmc_fmv_drift` 1,299 → **21**, `circ_badge_vs_minted` 3,858 → **359**, `rpc_badges_atlas_none` 966 → **2**, `badge_editions` 9,471 → **13,915 rows of which 4,403 are parallels** (there were none). And it surfaced a fifth defect the first pass could not see: 352 Moments still base-keyed whose nfts are **absent from `topshot_moment_subeditions` entirely** — the resolver's four seed arms only reach the newest two series, so older parallel sets are never queued. `20260904133011` + `133105` add the missing arm (and make it yield to the resolver queue so the newest series aren't starved).

## Also shipped this pass

- **Any USERNAME 500'd `/api/collection-moments`** — the live resolver host is decommissioned and the same call sat in **nine** routes. Cache-first against the 9,370 names in `wallet_usernames`; the fallback's failure is now an honest 503, a live not-found an honest 400.
- **850 Series-1 Top Shot thumbnails were 404s** (`20260904052346`) — repointed to the `media/<id>/image` endpoint every later Series uses.
- **`/nfl-all-day/sniper` had never once loaded its floor** — leg one 403s, leg two measured 16,767 ms against an 8 s bound. Rewritten to **204 ms**; the page renders 97 deals.
- **The five collection roots were 307-ing to `/login`** though every entity breadcrumb links them.
- 🚨 **pg_cron jobid 55 unscheduled** — 25 of 25 ticks died at pg_net's 90 s wall and *blocked every other pg_net request on the platform behind them*.

## Still Trevor's

1. **`#104 / 284` vs Top Shot's `#104/249`** — the chain returns all printings, Top Shot displays the Standard's own mint, and the moment page's parallel ladder therefore double-counts. Atlas's per-printing number is now in `badge_editions.circulation_count`. Deliberately not changed unilaterally: the column is owned by `topshot-circulation-onchain`, which the concurrent session shipped hours earlier, and the denominator feeds serial rarity everywhere. Full argument in the ledger entry of the same date.
2. The structural items unchanged from 09-03: #22 defeated credential purge · #58 `OPENSEA_API_KEY` · alerting secrets.
