# NFL All Day — collection roadmap (refreshed 2026-10-17, PT)

> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands

**All Day is the only collection failing its accuracy gate.** M2 = All Day HIGH/MEDIUM share ≥ 30 %. Live read ~6:00 PM PT 10-17 from `rpc_trust_health_history` (`allday_fmv_high_med_share_pct`, one row per leg, 999 sentinel excluded):

| PT week | mean | min–max | legs at bar |
|---|---|---|---|
| 09-14 | 28.6 | 21.2–31.7 | 9 / 28 |
| 09-21 | **27.9** | 24.4–31.0 | 7 / 28 |
| 09-28 | 26.3 | 25.1–27.9 | 0 / 28 |
| 10-05 | 27.2 | 26.6–28.2 | 0 / 28 |
| 10-12 (partial) | 26.3 | 26.0–26.9 | 0 / 23 |

- **The last leg at the bar was 2026-09-22 12:48 PM PT.** That is 0 of 107 legs since then. The latest precompute (12:48 PM PT 10-17) reads share 26.4 · fresh-24h 44.8 · sweep-24h 58.8 · stale-30d 0.0.
- ⚠ **The canonical roadmap's wk 09-21 figure (24.8) does not match this series.** Re-derived the same way as the 10-10 block in [roadmap-status.md](../../reference/roadmap-status.md), the week reads 27.9. The other three weeks agree.
- **Confidence mix** (`edition_fmv_current`, 6,190 editions, ~6:00 PM PT 10-17): LOW 1,750 (median FMV $1.00) · MEDIUM 1,444 ($0.21) · ASK_ONLY 1,205 ($10.80) · STALE 882 ($69.25) · NO_DATA 700 · HIGH 206 ($0.16) · SALES_ONLY 3. This is a different population from the 10-10 sizing (latest-3-days, 4,605 editions), so do not difference the two.
- **The price is better than the label suggests.** `fmv_sales_backtest('nfl_all_day', 7)` from the [10-17 overnight pass](../../handoff-2026-10-17-overnight-pass.md): ALL 20.0 % median error, 56.4 % within ±25 %, ratio 1.059, $0.04 median dollar error. HIGH is 13.3 % / 71.6 % and MEDIUM 17.6 %. R125 was closed 10-17 on a PAIRED read: All Day MEDIUM 18.2 vs 22.7 and LOW 25.5 vs 27.3 against a naive last-3 median. The HIGH residual is under one 5¢ tick ([deep-audit-register.md](../../audits/deep-audit-register.md)).
- **Volume** (`sales`, PT weeks): 08-24 255 · 08-31 911 · 09-07 5,757 · 09-14 3,067 · 09-21 2,659 · 09-28 5,191 · 10-05 4,388 · 10-12 2,579 (partial, to Sat 6 PM). Median price is well under $1. The NFL season roughly quadrupled volume against August, but M2 did not move. **Volume alone is not the binding constraint.**
- **Pipelines:** all 35 All Day lanes in `pipeline_runs` read `ok` on every run in the 24 h to ~6:00 PM PT 10-17. That includes the storefront reconciler (16,872 listings walked, 15,258 written at 4:13 PM), `compute-allday-pack-ev` (circulation-weighted, 0 RPC errors) and the Flowty `allday-listing-cache` (72/72). ⚠ **"ok" is not "working" for one of them** (see Open issues).
- **Primary packs:** the latest All Day drop start in `allday_drop_windows` is 2026-03-29 and none fell in the last 30 days. Pack EV is a secondary-market and historical product here ([packs.md](../../reference/packs.md)).

## Shipped recently (since mid-September)

- **10-20 (Cowork cloud, ~7:20–7:55 AM PT): the V1 ask book is checked against the chain, once and from now on.** #197: 2,862 buyable Dapper listings the 09-25 closure took down are back (`20261020142417`). Then every open `direct_v1` ask was read on chain for the first time: 464 dead closed, 287 of them an edition's floor (`20261020143828`). #198: pg_cron 762 re-verifies V1 weekly (`20261020144618`). ⚠ **A change point for M2 and the floor-ask reads:** both moves change `cached_listings_v2`, which the LOW→MEDIUM corroboration reads through `allday_edition_floor_ask`; split any M2 or ASK_ONLY read on 10-20 ~7:40 AM PT.
- **10-18 (Claude Code cloud, ~4:18 PM PT): All Day surfaces stop reading Flowty's v1 slice.** The Analytics Order Book Depth card counts **28,857** on-chain asks (was Flowty's 108); `/nfl-all-day/market` no longer falls back to v1 on an empty answer (verified on production); the concierge's search, catalog-deal and live-deal fallback tools read `get_allday_market_editions_v3` / the edition floor view ("Mahomes": 0 → 26 listed editions), scoped to the resolved person.

- **09-25 · Flowty fork closed `unpurchasable`.** 27,406 listings sat on a storefront fork whose `purchase()` asserts false. They were setting the ask floor, and so the FMV ceiling, for 2,724 editions (`20260925230134`).
- **09-25 · Dapper storefront reconciler covers All Day** (`?collection=nfl_all_day`, Vercel `13 1-23/2`). Job 19's ask lane now tracks its own floor in both directions.
  - **10-09 fix:** a 4,080-listing seller blew the Cadence computation limit. The reconciler now reads 300-id slices pinned to one block height (`86ed83c3e`).
- **09-26 · Packs are judged against their drop's real sale window.** `allday_drop_windows` (pg_cron 623): 3,214 of 3,228 distributions now have a start time, and REWARD drops are $0.
- **09-28 → 09-30 · Unmapped sales recovered.** Duplicate rows were blocking price recovery and were removed. Multi-NFT V1 carts are now priced per NFT.
  - **#161 decided:** pack buybacks count as market sales and are tracked separately. Since 10-03 (#169), FMV writers read `sales_market`, which excludes buybacks.
- **09-29 · Holdings and the sniper.** 2,535 sold moments were removed from holdings where they sat as "locked" (`prune_allday_wmc_sold_away`, job 641). The sniper's player and franchise team searches now cover the whole pool.
- **10-03 · FMV 1.8.0 and the out-of-sample instrument.** Sales-only FMV is now the median of the 7 most recent typical sales, and `fmv_sales_backtest` was added.
- **10-04 · `allday-lock-refresh` re-walks a wallet only when its oldest check is ≥ 24 h.** Rows re-stamped per day fell from 2.6 M to ~428 k.
- **10-10 · Ghost listings removed from three surfaces:**
  - sniper top 50: 50 ghosts → 0 (`20261010085726`)
  - Market editions board: 282 of 500 floors fixed (`085932`)
  - edition-page "N listed": 1,464 editions corrected (`090525`)
- **10-10 · Two more 10-10 ships:**
  - **#70:** accepted offers become `offer_fill` sales. 236 All Day `offer_fill` rows exist since 10-10 (live).
  - **#182:** the Binder shows the edition's live ask.
- **10-11 · #160 closed** (324 open, 0 inflow). **Live 10-17: 0 open All Day `unmapped_sales`.**
- **10-13 → 10-15 · Market and sniper:**
  - badges are back on the Market (10-13)
  - filter lists cover the full catalogue and team picks cover the whole franchise (10-14)
  - Owned / Not owned filters the whole market (10-15)
  - **R127 (10-15):** the sniper opens on Recently Listed and shows MIN DISC. again
- **10-14 · #191: the delete cap now accepts an on-chain confirmation.** It confirms only when an independent on-chain count equals the walk's own count and the studio walk was complete. **Exit met live 10-17: wmc for `0x6d1f8c18412c6abc` = 2.** The watch can close.
- **10-15 · Flowty lanes fail on an empty book** (`f0b7f7ba5`), so the shutdown alarms on its first tick.

## Open issues

0. ✅ **DONE 2026-10-18 10:06 PM PT — the venue row names V2.** It had named V1 NFTStorefront primary (verified 05-18) while V2 carried 7,228 of ~7,580 sales in 14 d (re-read 10:00 PM PT: V2 7,228 · V1 91). Applied by one-off pg_cron job 753 (`UPDATE 1`); `v_collection_marketplace_status` reads `dapper_storefront_v2`. Record + revert: `docs/audits/2026-10-18-marketplace-status-allday-primary-venue.sql`. Blast radius small: no code reads `primary_venue`; `notes` is a tooltip/banner string.
1. **M2 not met.** 26–28 % for four weeks, with 0 of 107 legs at the bar since 09-22. No open register number. It is tracked in roadmap-status.md, 10-10 block.
2. 🆕 **`allday-buyer-backfill` reports `ok` while writing nothing.** Live read, `pipeline_runs`:
   - 10-14: 2 runs, 960 written · 10-15: 3,243 written, 597 decode-failed
   - **10-16: 0 written, 3,840 decode-failed · 10-17: 0 written, 2,880 decode-failed**
   - every run is `ok=true`, and each `extra` reads `decode_failed: 480` of 480
   - the cursor keeps walking back past the failed rows (now 2025-10-06, floor `FORWARD_WINDOW_START` 2025-01-01)

   This is the R123 write-side class: a run counted a success that resolved nothing. It matches the route's own warning that pre-current-spork transactions cannot be decoded via current REST. If so, the 10-10 sizing (82,984 rows, ~22 days) counted rows that can never resolve. Total null-buyer All Day `sales`: 590,508 (live). ✅ **Filed and fixed the same evening as [#192](../../reference/known-issues.md):** the floor is now mainnet27's root (2025-10-22); a decode wall or a failed UPDATE fails the run. Pre-spork null-buyer rows are retired from this lane, not resolved.
3. **Flowty shutdown pending** (Trevor 09-25, "soon"). `allday-listing-cache` still ingests 72/72 a day into legacy `cached_listings`. No priced column depends on it (re-verified 10-03), and the remaining work is only teardown.
4. **ASK_ONLY 1,205 and STALE 882 together are a third of the catalogue.** ASK_ONLY is the worst backtest bucket (ratio ~1.8, n 68). STALE (median $69) moves only with sales. ✅ **10-22 ~9:50 PM PT (Cowork cloud, [#208](../../reference/known-issues.md), `20261023044923`): the ASK_ONLY half is addressed.** Re-measured at n 326 / 30 d: ratio 1.80, within ±25 % 25.2 %, WAPE 132 % — 115 offer fills at ratio 2.70, 211 listing purchases at 1.35; the asks were fresh, so the lowest ask on a thin edition is simply not where it clears. An All Day ASK_ONLY price is now capped at the median of the edition's last 3 market sales within 180 d (BEFORE INSERT guard, all three writers; backtested `min(ask price, last-3)` 1.00 / 34.4 / 61.6 on the 256 sales with such a history); 682 of 1,392 current rows re-stamped ($130,408 → $120,820). The 591 with no sale in 180 d keep the ask × 0.90 — nothing else to price from without a bid book. STALE's 21 listing sales in 30 d read ratio 6.0 (n small) — same shape, next candidate once n is meaningful.

## Next — prioritized

**Now**
- 🆕 **Watch the ask-corroboration fix (10-17 ~7:25 PM PT, `1bfc17c86`).**
  - What: All Day LOW→MEDIUM corroboration had been OFF since ~09-25 — the fmv-recalc liveness probe read a NULL `listed_at` (4,913 `storefront_v2` rows; DESC sorts NULLs first) and logged `UNDATABLE (no lift)` on every run. 158 LOW editions met the rule at the fix; their published FMV priced like MEDIUM (14 d: 20.7 % vs 20.0 % median error, n 855).
  - Read: M2 on the 10-18 legs (expected ~29 %, an estimate — measure it); `fmv_sales_backtest` weekly on the moved set.
  - ↳ **Read 10-18 ~7:30 AM PT (Cowork cloud):** legs **30.8 % (12:48 AM PT, the first at the bar since 09-22) → 29.3 % (6:48 AM PT)**. Two effects overlap: this fix lifted the share ~4 pts (26.7 → 30.8), and FMV 1.8.2/1.8.3 (MEDIUM needs a usable sale in 30 days, decided 10-17) demotes it as the cold MEDIUMs are re-stamped. Projected settle **~27.1 %** once 228 pending MEDIUMs with 0 sales in 30 days go LOW. That drop is a label correction by decision, not a regression; book M2 per full NFL week. Remaining LOW, recalc-priced (1,032): 348 with 0 sales in 30 d · 379 with 1–2 · 174 with 3–4 (the live ask disagrees or is absent) · 131 with ≥ 5 (the dispersion gate, kept by decision). No lever passes the corroboration tolerance today without new evidence.
  - Falsifier: the moved set's within-±25 % share > 3 pts below MEDIUM's on two consecutive weekly reads → revert.
- ✅ ~~**Verify #192 on production runs**~~ (fix shipped 10-17) — **VERIFIED 2026-10-17 ~11:20 PM PT (Claude Code, Windows box): the 8:15 PM PT run wrapped (`wrapped: true`, cursor below the new floor) and the 11:15 PM PT run resolved **480 of 480** buyers (453 via deposit, 27 via tx authorizers, `decode_failed 0`, 81 s), cursor now 2026-10-11 02:51 UTC. Outcome table, not the self-report: all **3,211** All Day sales above that cursor carry a `buyer_address`. Backlog at or above the 2025-10-22 floor: **14,831** null-buyer sales of 328,221 (4.5 %); at 480/run × 8 runs/day ≈ 4 days.**
  - What: the next runs should wrap, then show `buyers_resolved > 0`, or an honest `ok=false` decode wall. Re-size the backlog from rows ≥ 2025-10-22.
  - Why: the lane logged success while resolving nothing for two days.
  - Falsifier: rows ≥ 2025-10-22 also fail to decode, which would mean a decode bug rather than the spork boundary.
- **Re-cost M2 against today's mix** (the 10-10 instruction).
  - ↳ **Checked 10-18 ~2:19 PM PT (Claude Code cloud): the corroboration ask is a sound source.** The LOW editions held back with 3–4 sales because the "live ask disagrees or is absent" read `allday_edition_floor_ask` (cached_listings_v2, ghost listings excluded), not v1 `cached_listings` (Flowty-only for All Day, 108 rows). So "absent" is a market fact, not a source gap. Do not re-open this as a lever.
  - What: split LOW (1,750) by sales count, and sample ASK_ONLY (1,205) and NO_DATA (700) for editions that have recent sales but no price.
  - Why: ASK_ONLY and NO_DATA appear to have grown since 10-10, on a different basis. Check whether that is composition or a pricing-path miss before any lever.
  - Gate: same instrument, repeat-vs-new cohort split (roadmap-status 09-20 trap).
  - ↳ **Read 2026-10-18 ~10:18 AM PT (Claude Code cloud) — ASK_ONLY and NO_DATA are COMPOSITION, not a pricing-path miss.** Joined `edition_fmv_current` (6,190 All Day editions) to `sales_market` (price > 0):
    - **NO_DATA 698: 0 have EVER sold.** Nothing to price from.
    - **ASK_ONLY 1,203: 1 sold in the last 30 days** (and that sale landed after its compute, a timing case). 1,135 have sold at some point (median 14 lifetime sales), 164 in the last 60 days, 305 in 90. They are outside the 30-day sales window by design, not missed by it.
    - **STALE 881: 0 sold in 30 days**, 880 ever sold, 23 in 60 days.
    - So none of the ~2,780 non-sale-priced editions is a recent-sales edition the pricer dropped. **M2 can only move through LOW → MEDIUM (and MEDIUM retention), not by recovering these three buckets.** LOW 1,602: 1,044 with a 30-day sale, 362 with ≥ 3 (the morning's lever split stands). MEDIUM 1,596: 119 with 0 sales in 30 d, still to be demoted under 1.8.2/1.8.3.
    - Widening the sales window to 60–90 days would label at most 164–305 ASK_ONLY editions, at prices ≥ 30 days old — which is what STALE already means. **Not a lever; do not re-propose it** without a backtest showing 31–90-day sales predict today's price.
- ✅ ~~**Close the #191 watch.**~~ **CLOSED 2026-10-17 ~6:49 PM PT** in the register (wmc All Day for `0x6d1f8c18412c6abc` = 2; the 6:27 PM PT walk did not bring rows back). This line was stale until 10-18.
  - Why: the exit is met (wmc 2).
  - Falsifier: the confirmed-deleted rows reappear on a later walk.

**Next**
- ✅ **DONE 2026-10-20 ~5:35 PM PT (Claude Code cloud, `20261021003446`)** — `allday_edition_floor_ask.floor_ask_verified_at` added (freshest verification over the listing's open twin rows: 594 stale storefront_v2 twins of fresh direct_v2 rows, read 10-20); `get_edition_high_offer` and the deals MV's All Day arm return it; `askStampKind("nfl_all_day")` = `checked`; the deals board's All Day exclusion is gone; the Market tab carries no All Day stamp (its only timestamp was the edition's newest listing, never the floor shown). Expect V1 floors (re-verified weekly by #198) to read "⚠ ask unconfirmed Nd" on edition pages between weekly passes — that is true, not a regression. Residue: the old MV renamed `mv_cross_collection_deals_pre20261020` (unread, 136 kB) awaits an attended `DROP`. Guard: `allday-ask-stamps-are-verifications.test.ts`. Golazos followed the same evening (`20261021004010`, see laliga-golazos.md). Original item: **All Day ask stamps say when we CHECKED, not when the seller POSTED** (scoped out 10-20, Cowork). Every open All Day row now carries `verified_at` (V2 reconciler every 2 h; V1 lane #198 weekly), but every surface still dates the ask by `listed_at` and words it "listed N ago" (edition page `750249b`, Market tab + alerts `49ae606`). The real fix: add `floor_ask_verified_at` to `allday_edition_floor_ask`, return it from `get_edition_high_offer` and the market RPCs, switch `askStampKind("nfl_all_day")` to `checked`, and drop the deals board's All Day exclusion (`DealsBoardClient.tsx`). Four read paths + RPCs; do them in one change or the kind and the stamp disagree on some surface.
- ✅ **DONE 2026-10-20 ~8:20 PM PT (Claude Code cloud, `20261021024344`):** new `get_allday_market_editions_v4` / `get_golazos_market_editions_v2` add the floor row's `floor_ask_verified_at` inside the existing aggregate (+28 buffers, +15–20 ms); the Market tab dates the floor ask it shows by its last on-chain check (ledger). Original item: **Market tab: restore an ask age on All Day / Golazos edition rows** (opened 10-20). Since `20261021003446` they carry none: their only timestamp was `last_listed_at`, the edition's NEWEST listing, which never described the floor shown. A per-row floor `floor_ask_verified_at` lookup from the route costs ~26k buffers per 500-row window (measured), so do it inside `get_allday_market_editions_v3` / `get_golazos_market_editions` (e.g. `(array_agg(cl.verified_at ORDER BY cl.price_usd, cl.verified_at DESC NULLS LAST))[1]` in the existing agg). That is a return-type change, i.e. a DROP — the MCP holds DROP for a human, so ship it attended or under a new function name. Low priority: the edition page, deals board and alerts already carry the checked age.
- ~~**Shrink ASK_ONLY honestly.**~~ ⛔ **Measured 10-17 ~7:20 PM PT: nothing to shrink.** Of 1,207 ASK_ONLY editions, 1 has a `sales_market` sale in 30 days and 308 in 90 days, none with ≥ 5; NO_DATA (700) has 0 in 90 days. The label is honest; the lever below would move ~1 edition. Re-open only if that 30-day count grows past ~50.
- (original item, kept for the record) **Shrink ASK_ONLY honestly.**
  - What: a sales-backed price wherever `sales_market` has ≥ 1 recent sale. No relabelling.
  - Why: ASK_ONLY is the least accurate tier.
  - Gate: within ±25 % on the moved editions ≥ MEDIUM's in `fmv_sales_backtest`. Reverse it otherwise.
- **Flowty teardown, on the day it goes dark.**
  - What: retire `allday-listing-cache` and its scheduler (cron-job.org presumably), then drop the `flowty` rows deliberately.
  - Gate: the lane's own `pageErrors` and empty-book failures, not one probe.
- **Weekly paired backtest read.**
  - Why: R125 reopens if a tier's paired within-25 share sits > 3 pts below last-3 on two consecutive weeks.
  - ↳ **Read 10-22 ~9:40 PM PT (Cowork cloud, 7 d):** HIGH published 7.1 % / 84.5 within ±25 % (naive 12.5 / 70.8 — published wins), MEDIUM 20.0 / 59.7 vs 20.0 / 58.1 (level), LOW 25.9 / 49.5 vs 23.1 / 51.9 (2.4 pts below; inside the rule, first week). ASK_ONLY 170 % / 8.6 / ratio 2.70 → the #208 cap above. Next read ~10-29.

**Later**
- **Book M2 per full NFL week** from the series, never a leg. The season runs to February, so volume will fall after it.
  - Falsifier for "volume will fix it": four weeks at ~4× August volume left M2 flat.
- **STALE high end (882 editions, median $69):** the only lever is more sales, so it stays labelled. Revisit only if a backtest shows the label is wrong.
  - ↳ **A backtest showed the PRICE was wrong (2026-10-23 ~3:20 PM PT, Cowork cloud; #209):** on 60 d of sales under a current STALE snapshot (n 61) the published price read 5.0× realised (8.2 % within ±25 %) while the edition's own last sale read 2.0× (23.0 %). STALE prices are now capped at the last market sale (`20261023222201`, 189 of the 512 All Day STALE rows with a qualifying sale re-stamped, median 1.60× lower); the label is untouched. Weekly read beside the ASK_ONLY cap from ~10-30.
- **Pack EV:** keep it historical and secondary. No primary-drop work unless `allday_drop_windows` shows a new start.

## Decisions on record (do not re-litigate)

- **10-10 ~3:15 PM PT: the 0.35 dispersion gate stays.** The 7+-sale LOW set misses by a median 25.0 % against MEDIUM's 20.0 % (n 463 / 2,405). Re-open only if a later backtest puts that set level with MEDIUM. ↳ **Re-measured 10-21 ~7:15 AM PT (Cowork cloud), same instrument shape (`sales_market`, 14 d, serial > 25, snapshot in force 1 day before each sale): still NOT level — LOW 7+ median error 22.1 % vs MEDIUM 18.8 % (n 874 / 3,451), within ±25 % 57.7 vs 61.2, median miss $0.05 vs $0.04. The gap narrowed from 5.0 to 3.3 points, so re-read it weekly; it is level with MEDIUM's 5–6-sale subset (58.4 % within ±25 %), which has no spread test at all — the gate's inconsistency, not a reason to relabel. (MEDIUM 5–6's WAPE of 58 % is one real print — Alohi Gilman Common #1183 sold for $200 on 10-08 between unrelated wallets, FMV $0.17 → $0.15 — so read that group on median error / within ±25 %, not WAPE.) Sized: 121 editions today, +1.9 pts (27.2 → 29.1 %), so even a relabel would not by itself pass M2. Top Shot's LOW 7+ (106 editions, 7 d) reads 67.1 % within ±25 % vs MEDIUM 63.2 %, but that collection already meets M1.
- **09-30 #161 + 10-03 #169:** buybacks count as market sales and are tracked. FMV writers exclude them via `sales_market`, in one view only.
- **09-25:** the Flowty fork is `unpurchasable`. All Day asks come from Dapper's storefront.
- **Standing:**
  - read-only product (no cart, trade or gifting)
  - accuracy is the gate, so no growth tactics until M2 passes
  - no paid tier until 100 WAU
  - no infra spend pre-revenue

## Needs Trevor

- **Nothing All Day-specific is blocked on him.** The M2 re-costing is code work.
- **External:** the Flowty shutdown date. When he hears it, the teardown above runs.
- **Only if M2 stays flat through the season:** whether the gate bar or tiering should change. Today's answer is no (10-10), and it needs a backtest before it is re-asked.

## Where the detail lives

- Gate series and the 10-10 decision: [roadmap-status.md](../../reference/roadmap-status.md) (10-10 HEADLINE block, plus the 10-03 backtest block)
- #70, #160, #161, #191 and every closed item: [known-issues.md](../../reference/known-issues.md)
- R123, R125 and R127: [deep-audit-register.md](../../audits/deep-audit-register.md)
- Pack ingest and drop windows: [packs.md](../../reference/packs.md)
- Dated ships and revert paths: [ledger.md](../../overnight/ledger.md) (09-25, 09-26, 09-29, 10-04, 10-09, 10-10, 10-14, 10-15)
- Session summaries: [sessions/2026-10.md](../../sessions/2026-10.md)
