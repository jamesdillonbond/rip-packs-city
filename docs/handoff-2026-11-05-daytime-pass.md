# Daytime pass — 2026-11-05 (~11:36 AM – ~7:05 PM PT)

**Session:** Claude Code cloud, repo attached with push (`git push --dry-run` exit 0), `npm ci` ok. Trevor: "work autonomously for the next two hours, working through any known issues, roadmap items, handoffs … Fix any issues you encounter."

**Verdict: GREEN · 0 production shipped · 0 reverted · idle: blocked (production DDL refused in this session) · oldest routed: `20261105063000` 1 night.**

> ⚠ The `apply_migration` refusal is specific to **this cloud session** (its auto-mode classifier treats a production DDL apply as a production deploy). Trevor's machine, Cowork and Claude Code sessions with approval apply migrations normally. **Apply the two committed migrations below as usual.**

## Update ~1:27 PM PT — items 1 and 2 APPLIED (Trevor approved in chat)

- `20261105063000` applied (recorded `20261105212546`): live body hash = the committed file's; `/nba-top-shot/edition/169:6317` now reads "capped at sales".
- `20261105194500` applied (recorded `20261105212641`): pg_cron **829**, All Day 10-26 baseline 1,841 sales, 62.1 % within ±25 %.
- The mint walk's 11-05 scheduled run fired at 12:14 PM PT (success).
- #208 part (a): no ask multiplier is a lever on post-reopen data (register).

## Update ~1:40 PM PT — #213 SHIPPED (decided under Trevor's delegation, applied with his approval)

- `20261105213600` (recorded `20261105213950`): All Day editions of circulation ≤ 50 cap a STALE price at the last non-premium sale. 176 prices re-priced ($42,159 → $24,946), backed up and logged in `fmv_restatements`. Edition 1919 now reads $69. Item 3 below is done.

## Update ~5:07 PM PT

- **Scheduled tasks:** the 11-09 weekly-digest verify and the 11-11 Rookie Debut readiness check were reminders bound to old conversations (the shape that failed eight times before). Recreated as standalone tasks at the same times; originals paused (Trevor approved). Ledger has the IDs.
- **Vercel's chronic error groups** for edition / player / set detail and the fmv-recalc `55P03` lock timeout all last fired 11-04 7:47:57–7:48:22 PM PT — between that evening's bulk Top Shot re-price (`20261105034410`) and the next apply's schema reload (`20261105034852`). The known apply-burst cost, not four defects; do not chase them unless they recur outside an apply window.
- **#213 survival read:** all 176 re-priced prices held; 24 already rewritten by the sweep, all at the intended value.
- **#66 owed CTR measurement done:** price stays out of edition titles (table in `docs/strategy/seo-2026-09-06-search-console-read.md`).

## Update ~7:05 PM PT — thread close

- **Panini >9 d priced tail (routed by the evening Cowork handoff) — FIXED in runner code (`a1124dff`).** The 10-18 walk weighting gave World Cup half of every walk because it was the only priced product; every product is priced now. Read 7:00 PM PT: WC 5,288 editions p50 33 h, 0 older than 9 d; others 35,013 (17,064 HIGH/MEDIUM) p50 103 h, 8,274 older than 9 d. `PANINI_PRICED_PER_OTHER` now defaults to 0 (stalest-first). Live after the laptop's 5:37 AM PT pull; read 11-07 (focus.md Panini steer).
- **Evening apply recorded:** `supabase/migrations/20261106024733_ts_sold_floor_clear_reads_unmapped_sales.sql` (Cowork applied `close_sold_topshot_listings_and_floors` at ~6:47 PM PT; the file body equals live `prosrc`; anon/authenticated EXECUTE false).
- **Items 1–3 below are DONE** (applied / shipped earlier today). The `cadence_exempt_lanes` chain-arrivals DELETE is also done: the Cowork evening session ran it ~8:08 PM PT with a backup (`audit_20261105_chain_arrivals_cadence_exempt_backup`, RLS on, anon no access); the table read empty at 8:20 PM PT. Still Trevor's: two Vercel rate-limit firewall rules, branch protection on `main`, plus item 4.
- **Owed reads:** Panini backlog + walk 11-06 / 11-07; #210 0.90-haircut lead with the 11-09 week; first All Day accuracy row from job 829 on Mon 11-09 3:45 AM PT.

## Queued for Trevor / Claude Code

1. **[P1, apply-capable session, 1 night] Apply `20261105063000_audit_20261104_edition_detail_capped_survives_bid_floor`.** Edition pages still say "from asks — no corroborating sales" on Top Shot prices that a sales cap set and a live bid then lifted (71 rows on 11-04). Re-read 11-05 ~11:40 AM PT: live `get_edition_detail` body md5 = `377eb913…` (the file's guard), anon EXECUTE false; the file differs from its base `20261029164512` by the one regex. Post-checks are in `docs/handoff-2026-11-04-edition-detail-capped-bidfloor.md`.
2. **[P2, apply-capable session, 0 nights] Apply `20261105194500_audit_20261105_fmv_accuracy_weekly_allday`** (#234 exit step 2). New pg_cron `rpc-fmv-accuracy-weekly-allday`, Mondays 11:45 UTC (3:45 AM PST, 8 min after Top Shot's 828; minute 45 of hour 11 otherwise empty), plus the 10-26 baseline week. `refresh_fmv_accuracy_weekly` is already collection-generic (read live), so no function change. Parse-checked; guard tests green. After apply: fill the jobid in `docs/operations/cron-schedule.md`, rename the file if the recorded version differs, ledger line.
3. **[P2, Trevor decision, 0 nights] #213 — ship or close the premium-serial STALE cap.** Re-read today as the item scheduled. All Day, 120 d, cap at the last non-premium sale (not #1 / jersey / last mint) vs today's `serial > 25`: WAPE better in all four cells; within ±25 % ties or wins three and loses one sale of 92 in the circulation > 50 recent cell (30.4 → 29.3). 34 moved sales vs the item's ≥ 60 bar, the same picture as 10-29. The live case is unchanged: `/nfl-all-day/edition/1919` publishes $520 over a newer $69 sale. A ship is a one-predicate change to `fmv_snapshots_cap_stale_to_last_sale()`.
4. **[P3, Trevor, carried] #58 OPENSEA_API_KEY** (Candy re-verify ~11-27). **cron-job.org MFA** (from the 11-04 incident). **`net._http_response` growth lever** (weekly read ~11-11).
5. **[watch, carried] #228** cold-whale `/api/collection-snapshot` timeout — absent from today's 24 h error window. **Panini backlog** — reads 11-06 and 11-07 owed (focus.md).

## Closed / RESOLVED this pass

- **#226 CLOSED on its exit.** 200/200 chain-verified map rows (100 newest-minted incl. 53 parallels; 100 newest parallels) match their MomentMinted record on set:play and subedition. The checkpoint reconciler has completed 6 full sweeps; its last full pass (4:57 → 10:57 AM PT) found 0 disagreements. Residue is written into the item so nobody re-derives it as a defect.
- **refresh-conflated-editions steer** (focus.md) — the 11-05 7:17 AM PT tick landed on schedule.

## Measured (read-only), recorded where the next reader looks

- **#208 weekly exit MET:** All Day ASK_ONLY 7 d ratio 1.008, within ±25 % 44.2 % (bar 30). Capped rows 48.2 % vs 25.7 % for the same rows uncapped, so the falsifier is not met. Part (a), the no-history rows at ratio 1.62, stays open.
- **#209:** too thin (Top Shot STALE n 0, All Day n 4).
- **#210:** Top Shot LOW reads 0.897 this week, but the haircut rows the item changed keep improving (ratio 0.630 → 0.729 → 0.750; within ±25 % 39.9 → 45.2 → 50.7). The dip is the untouched rows (1.000 → 0.945). New lead, not shipped: a 0.90 haircut instead of 0.75 wins or ties every cell on clean post-10-23 snapshots, by small margins; re-read with the 11-09 week.
- **Pinnacle #193 exit (owed since ~10-30):** holds. HIGH n 561, published 75.6 % vs naive last-5 75.4 %, WAPE 22.9 vs 23.3.
- **Golazos:** ASK_ONLY 84.6 % within ±25 %, ratio 0.900 — ⚠ the same 52 sales as the 10-29 read: Golazos has had **no market sale since 10-25**. Verified dead, not blind (the indexer sees every other Dapper type; the storefront reconcile closed 0 of 4,491 listings in 48 h). See `docs/strategy/collections/laliga-golazos.md`.
- **Top Shot premium-serial read:** circulation > 50 qualifies (wins or ties every cell, 60 moved sales) but would re-price only 2 current prices — deliberately not shipped; ≤ 50 loses. Recorded in #213.
- **All Day weekly read:** published beats or matches naive in every tier; LOW's 0.773 is the sub-$1 market step in the non-haircut rows, not the haircut.
- **Panini backlog:** 14,755 editions older than 7 d (18,431 on 11-04), on track.
- **Mint walk:** the 11-05 scheduled run of `mint-event-walk-forward.yml` had not fired yet at write-up; the previous two fired at 11:45 and 11:59 AM PT (GitHub schedule lag). Check `gh run list --workflow mint-event-walk-forward.yml` for an `event=schedule` run dated 11-05.

## Health (`rpc_ops_snapshot()` 11:37 AM PT)

Security all `[]`. Trust 40/40 ok, 0 breaches. Stalled `[]`. 6 `info` alerts, all designed Atlas 403s with current 200s. Vercel: 10 chronic error groups; the newest is a `get_player_top_sales` timeout at 11:22 AM PT, degraded per design. Client beacon: no real error in 7 days. Accuracy, 7 d published: Top Shot 70.8 % within ±25 % (ratio 1.000), All Day 57.6 % (0.900, the real market move measured 11-04). DB 44,740 MB.

## Failed / blocked / reverted

- `apply_migration` of `20261105063000` refused by this session's classifier (not routed around).
- Nothing reverted.
