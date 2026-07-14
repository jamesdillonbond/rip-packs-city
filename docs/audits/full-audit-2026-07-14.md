# Full platform audit — 2026-07-14 (Cowork, Trevor-directed)

Scope: backend health, DB integrity, 340-page live sweep, Chrome visual QA, pack pages deep dive, scheduler verification (all 5 surfaces), competitor comparison, FMV/Pack-EV parity. Ships + reverts logged in [docs/overnight/ledger.md](../overnight/ledger.md) (2026-07-14 Cowork entry).

## Verdict

Platform is structurally healthy — trust 16/16 ok, security invariants 0/0/0/0, RLS 0 off, sentinel 0, all four pack-EV pipelines green, editions/FMV/badges/usernames coverage strong. The one systemic problem is **disk-IOPS starvation** on the Micro instance (two nights of REINDEX waves + trim churn drained the burst balance), which explains every "contention family" symptom observed: chronic statement timeouts (analytics-smoke ~58%/day, wallet-username-resolver ~44%), the 19-hour Sentry smoke failure, 26-32s pack-page renders, and real pages intermittently rendering as 404s. The heaviest per-request offenders were fixed this session (26.4s → 0.8s pack market lookup; 9.7s → 0.02s pack sales history); the throttle itself needs quiet time to refill — re-measure ~2026-07-15.

## Numbers (measured live 04:20–06:00Z)

- DB 8,239 MB (−2,805 vs 07-13 — trim landed). Editions: TS 19,284 / AllDay 6,190 / Golazos 575 / UFC 518. TS parallels 3,474, 0 orphans, 0 unnamed (after the Bit backfill).
- FMV H+M: TS 5,194 / AllDay 806 / UFC 15 / Golazos 4. Per-collection staleness all inside thresholds.
- Usernames: 5,954/6,020 resolved (98.9%). Badges: TS 9,272 (67% low_ask) / AllDay 5,607 (69%) / Golazos 218 (48%).
- Jersey numbers: 17,979/25,474 TS+AllDay editions.
- Page sweep: 338/340 OK (2 "404s" reproduced later as 200 — the contention-404 class, now code-fixed). Sales fresh: TS 6,302/24h, AllDay 482/24h; Golazos quiet since 07-11 (thin market); UFC dead (Aptos, permanent).

## What was broken and is now fixed

1. Pack dist page tail >25s (smoke-failing since 07-13 ~09:30Z): `v_*_pack_market` whole-table aggregate per lookup → `get_pack_market_row` per-dist RPC. Plus `get_pack_sales_history` missing price-ordered partial index.
2. Contention-404s: pack dist + team pages called `notFound()` on RPC failure — real pages (AllDay dists 5839/4031, Trail Blazers, KC Chiefs) intermittently 404'd/soft-404'd. Now throw (retryable) on RPC error.
3. TS subedition 9 unnamed ("Bit") → duplicate "Standard" row in parallel strips (16 editions).
4. `/moment/<id>` similar-editions cards blank ("—") for team moments.
5. AllDay pack pages: sealed/unopened count silently null (minted never selected).
6. `upsert_wallet_moments` 42P10 (silent wmc-write failure on /api/wallet/seed) — verified fixed.
7. ox3 REINDEX wave left un-finalized (missed pg_cron tick) — finalized manually; 0 invalid indexes DB-wide; postgres timeout reset.

## Open items (queued in ledger)

Atlas datacenter block (underpriced-#1s ingest down since 07-13; home-machine/browser lanes only), ownership-sync-dune weekly miss (Top Owners stale until 07-19), wmc unique-index drop candidate (analysis done, decision gated), 82 actively-trading TS editions without thumbnails, home-machine schedulers still down (operator), misattrib-drain Vercel cron 500 (CC-owned, carried).

## Competitor notes (v2.nbatopshot.com, dapper.market, app.nflallday.com, disneypinnacle.com, ufcstrike.com)

- **TS v2**: marketplace has quick-filter chips (Ultimates/Legendaries/Rares/**Autographs**/Rookies), a **Redeem** tab, WNBA league filter, 30d $-volume sort. Autographs + redemption are categories RPC doesn't track/surface yet.
- **dapper.market**: unified multi-league marketplace (TS/AllDay/Golazos tiles; no Pinnacle/UFC), live sales ticker. RPC's cross-collection intelligence remains differentiated — and covers Pinnacle, which Dapper's own aggregator doesn't show.
- **AllDay**: sunset confirmed (no new Moments); **5% Dapper-Balance rebate on marketplace buys through 2026-09-09 (12-month hold)** + "Founding Collector" designation — a live buy-side incentive RPC surfaces nowhere; "always-on pack rip" = secondary sealed-pack ripping (RPC's pack EV/reality boards are exactly the right tool — promote them on AllDay surfaces).
- **Pinnacle**: set-cards-in-progress (set completion) front and center; supply + list price per pin. RPC's Pinnacle scarcity/FMV boards are ahead on analytics; no set-completion tracker for Pinnacle yet.
- **UFC Strike**: Aptos migration banner (known, permanent) — Flow-side UFC UI disposition still queued (CC-owned).

RPC-side differentiators verified working live this session: FMV history + Activity + parallel premiums + special-serials + traced pack sales with wallet→username intelligence links — none of which the first-party sites offer at this depth.
