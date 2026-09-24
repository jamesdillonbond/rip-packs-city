# Handoff — 2026-09-23 evening health pass (Claude Code, cloud)

**Window:** ~4:14 → ~6:10 PM PT, 2026-09-23. Push-capable: plain `git push` from the cloud clone.
Every ship below has its own ledger entry (dated 2026-09-23) with a revert path.

## Health verdict — GREEN

- Security invariants `[]`; secdef-anon drift `[]`; search-path drift `[]`; anon write surface `[]`.
- pg_cron: 0 failures in 2,393 runs (6 h); no stalled pipelines; no wall kills; R118 blind handlers = 0.
- Site availability: 23/23 probes OK (2 h).
- **Vercel vs Sentry pairing:** Vercel's 1 h error groups after the deploys showed only the known DEP0169 `url.parse` warning. `/api/market` returned 29 × 200 after the filter deploy.
- **The one HIGH alert** (`compute-allday-pack-ev` failure_rate) was a stale window: the lane had been fixed at 09-22 11:07 AM. It is now `info` (item 1 below).

## Shipped (10)

| # | What | Where |
|---|---|---|
| 1 | The failure-rate alarm also splits at a lane's **last failure**, clearing the ~3-day false HIGH after any fix. Also shows the newest error rather than the lexicographic max | migration `20260923231922` |
| 2 | `alerts-dispatch` logs pool sizes beside the unconfirmed counts; a failed log write is no longer dropped | `app/api/cron/alerts-dispatch` |
| 3 | **Candy treasury = the sealed-pack custodian.** The moment-count argmax flipped at 3:39 PM PT and the public holder board ranked the pack custodian (93 % of sealed packs) as its #1 collector | migration `20260923233939` |
| 4 | **Market-tab Set / Series / Player / Min-price filters now work on Top Shot and All Day**, inside the RPC and before its LIMIT (known-issues #129 ✅) | migration `20260923234631` + `app/api/market` |
| 5 | The Candy listings indexer retires listings **superseded** by a newer one for the same 1-of-1 mint. 3 mints carried July phantom floors (#131 ingest half) | `app/api/candy-listings-indexer` |
| 6 | `drain_fmv_cold_tail` prices All Day off the live, ghost-filtered floor, not `badge_editions` | migration `20260923235425` |
| 7 | `check_candy_treasury_divergence()` now compares the **published label** with the custodian (it would otherwise have read red forever after #3), and adds `packs_stale` | migration `20260923235630` |
| 8 | R99 P2 dead modules deleted (Flow-wallet purchase template, `lib/logger.ts`, `PaywallModal`, `UpgradePrompt`) plus their brand-guard entries; lint ratchet 710 → 709 | 4 commits |
| 9 | Register hygiene: #130 closed (resolved 09-20, never recorded) and #125 closed on its own falsifier. The R94 row notes its last four boards were already done in `bc7a4825e` | docs |
| 10 | This handoff | docs |

Each DB change was dry-run first, inside a transaction that rolled back, with a positive and a negative control. Each has a file md5 equal to its `schema_migrations` row.

## Needs Trevor

1. **Is `1BWutmTv…DNix` a house wallet?** It holds 1,789 Candy MLB moments and 15 packs, and has **zero** marketplace activity (no buys, sells, listings or offers). Since fix #3 it is again the #1 collector on the Candy holder board, as it was before today. If it is Candy's own wallet, also exclude it. That is a labelling call, not a data one.
2. **#133 (filter pills hit-test to another element on `/insights/set-squeeze` + `/insights/offer-spread`)** needs a real browser against the live site. This sandbox's egress refuses the domain. On the laptop: `document.elementFromPoint` at each pill centre.
3. **known-issues register hygiene.** The index counts **60 "open"** items, and many carry headings that say SHIPPED or DECIDED. #125 and #130 were closed tonight only because their own falsifiers were checked. A dedicated pass (read each item to its end, test its exit condition, close or re-date it) would make the open count mean something again.

## Open / watch (not blocking)

- **Post-ship falsifiers:**
  - After the 5:35 PM candy-listings tick: active mints with >1 active row = 0 and `extra.superseded ≥ 3`.
  - After the 5:39 PM job 404: `candy_treasury_wallet` = `BhA2…`.
  - After the 5:26 PM job 436: the scarcity MV refreshes CONCURRENTLY.
  (Results are recorded in the session log.)
- **#91 (official badge art loses the first cold render):** the 24 h sample holds ~75 OG renders and **0** fallback warnings. That is too thin to size a budget change, and Vercel full-text log search over >24 h times out. Leave it open; re-sample weekly.
- **Not worth doing now, measured:**
  - `pack_ev_latest` (#118): 2.25 s / 59 MB sort per direct read. But only 3 direct reads ever; the MV serves the board. The 42 s mean for `refresh_mv_pack_ev_latest` in pgss is Small-tier history (pgss last reset 08-12); on Large, job 73 runs 4.5 s.
  - `sync_ts_listings_from_atlas` telemetry counts (#85): job 466 at 288 runs/24 h, max 14 s, 0 failures.
- **Sharded Top Shot wallets** (`0xe1f2…` etc., 7 users/day in wallet-backfill errors): still needs an off-chain id source. `topshot_ownership` / `moments` hold only partial rows for them, so rendering those would be a partial read published as the whole wallet. This is a design item.
