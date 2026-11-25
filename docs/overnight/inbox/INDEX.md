# Inbox index — 704 live filings

**Generated 2026-08-22 (PT) by Claude Code, deep-audit R27. Reconciled twice on 2026-08-22 evening: first from rot (193 listed / 196 on disk), then from a CONCURRENT CLOBBER — `a2bc6e9a` wrote back a copy read before the first reconciliation and took the file 198 → 192, burying nine filings including a HIGH-PRIORITY one. Both were caught by `__tests__/inbox-index-lists-every-filing.test.ts`, not by a reader. Counts here are asserted against the directory on every CI run, so do not hand-edit one without adding the entry it counts. ⚠ **ARCHIVING a filing means DELETING its entry here in the same commit** — this file maps the LIVE queue, and an entry for an archived filing tells the next session an item is open when it is closed (that happened 2026-08-23 and the guard caught it).**

## Why this file exists

`docs/overnight/inbox/` had not been archived since 2026-08-13 and had grown to 188 live
files nine days deep, so **drained and open became indistinguishable** and the run-3 audit's own
brief estimated "~29 files" — off by more than 5x. That miscount is itself the evidence the
signal had degraded silently, and it breaks cheap-check (1) of the audit protocol, which tells
every session to grep ALL of `inbox/*` before measuring anything.

## Why the files were NOT archived

⛔ **Since 2026-08-17 the inbox is APPEND-ONLY and this is enforced: `__tests__/inbox-is-append-only-since-the-rule.test.ts` reds CI if any filing dated on/after 08-17 sits in `archive/`** (filings are cited by exact path from the ledger, migrations and live code). A resolution marker does NOT make a filing archivable — retire it by appending a ✅ RESOLVED section and a marker on its line below. (2026-10-04: a Cowork pass archived 47 marked filings on the reading of the paragraph below; `main` went red and they were restored in `815c984`.)

Archiving by date was considered and **rejected**. The `rpc-nightly-autonomous-pass` task
DRAINS this directory: moving a filing that was never acted on would silently remove it from
that queue, and nothing would ever surface it again. A date is not a drained-determination, and
no per-item drained state exists to read. **Archiving is Trevor's call, not a chore** — the
safe half (making the contents scannable in one read) is done here; the destructive half is not.

## How to use it

⚡ **Entries filed before 2026-10-25 are TITLE-ONLY here (2026-11-24, `rpc-context-hygiene`, Trevor: "do it all").** Their one-line summaries moved verbatim to [inbox-index-archive.md](../inbox-index-archive.md) (same date headings; relative links there are re-based onto `inbox/`). The listing is still complete — every filing is linked here and the counts are unchanged; open the filing or the archive for the summary.

Scan this file instead of opening 188 documents. ⚠ It is a **listing, not a status**:
presence here says nothing about whether an item was acted on. The canonical open list is
[deep-audit-register.md](../../audits/deep-audit-register.md) — an item that matters and is
still open should have a register row, and if it does not, that gap is the finding.

⚠ **Regenerate this file when you add filings**, or it becomes another rotted map — the exact
failure it documents.

---

## 2026-11-25 — 2 filings

- [✅ DISPOSITIONED 11-24 ~8:33 PM PT (Claude Code, attended): SESSION PROBES, no lane — `pg_net_request_log` holds only 5 publicnode calls ever (7:17 PM 200, 7:56 PM ×4 403); no function or pg_cron job names publicnode (the one DB Solana caller, `candy_collections_discover_begin`, hits mainnet-beta daily); arm window 2 h, clears ~9:57 PM PT by itself — Daytime monitor — pg_net_http_403 arm reads CRITICAL on 4 Solana RPC 403s to solana-rpc.publicnode.com ("Indexed requests require a personal token"); self-inflicted, candy data fresh (no outage)](2026-11-25T0415Z-rpc-daytime-monitor-pg-net-http-403-publicnode-indexed-token.md)
- [✅ DISPOSITIONED 11-25 ~7:10 AM PT (Claude Code cloud, attended): DECLINED the SKIP-LOCKED extension. In this function the wmc UPDATE and the `rwfc_applied` record commit in ONE statement, so skipping locked holder rows would still mark the edition applied. The next run's unchanged-filter would then drop it, and the skipped holders would keep a stale price until the next price move: silent staleness in place of a visible, self-healing rollback. At 3 per 24 h the rollback-and-retry (about 5 min) is the correct behaviour. Re-open if trust `fmv_stale_touch_hours` breaches. — NEW 11-24 ~11:12 PM PT (rpc-daytime-monitor, LOW): fast-lane wmc writer `refresh_wmc_fmv_changed` hit a deadlock (40P01) at 04:13Z + a lock timeout at 04:18Z — self-cleared (next 10 runs ok), the only non-upstream fails in the 6h window; the 11-10 SKIP-LOCKED deadlock fix covered resync_stuck_wmc_fmv/reconcile but NOT this lane — night pass: confirm the partner from the Postgres log and consider the same ordered-lock treatment](2026-11-25T0712Z-rpc-daytime-monitor-refresh-wmc-fmv-changed-fast-lane-deadlock.md)

## 2026-11-24 — 3 filings

- [🔧 FIX APPLIED 11-24 ~7:00 PM PT (`20261125025303`, job 926 now `cron_heavy`, `53 5 * * *` UTC); ✅ first run 9:53 PM PT 11-24 succeeded, 102.5 s (old job 721: ok 55–98 s, failed at 120.1 s on 11-19/11-23 — so not yet PROVEN past 120 s; any run > 120 s that succeeds closes it, budget now 600 s) — Daily `rpc-topshot-misattrib-remap` timed out again — 2 of last 5 runs — UPDATE exceeding its statement_timeout at the 05:53Z slot (rpc-daytime-monitor, LOW; suggested fix = own 120 s budget or batch the UPDATE)](2026-11-24T1617Z-rpc-daytime-monitor-misattrib-remap-daily-timeout.md)
- [✅ ITEMS DONE 11-23 — 1–3 scheduled (Cowork ~7:10 PM PT), 5 merge applied (~7:06 PM PT), 4 UFC enrich fix shipped `f04a8cd` + edge deploy ~7:40 PM PT (drain verify tracked on 0114Z) — Claude Code → Cowork: create 4 one-shot scheduled tasks WITH the Supabase connector (a Claude Code cloud session cannot attach connectors) — 11-24 VACUUM verify, 11-25 Top Shot full-day lag read, 12-07 gate week 4 + R73/#234/#66 re-reads; plus the UFC enrichment-chain fix (edge deploy, LOW). Paste-ready prompts inside](2026-11-24T0252Z-claude-code-for-cowork-create-four-scheduled-checks-and-ufc-enrich-fix.md)
- [✅ RESOLVED 11-23 ~7:45 PM PT (`f04a8cd` + edge v66; manual walk: 149 + 6 enriched, both wallets 0 unkeyed) — Daytime monitor: UFC (ufc_strike) wmc null-`edition_key` = 155 (all new in 7d, 2 wallets) crosses the snapshot's >100 / >25-new watcher but has no continuous trust arm (the 11-10 wmc-null-key arm is Top-Shot-only); likely UFC-on-Aptos reopen churn — confirm a UFC resolver is draining it and decide on a healer leg / `ufc_wmc_null_edition_key_rows` arm](2026-11-24T0114Z-rpc-daytime-monitor-ufc-wmc-null-edition-key-over-watcher.md) — 🔎 DIAGNOSED 11-23 ~5:55 PM PT (Claude Code cloud): NOT self-draining — enrich chain's 45 s caller timeout < one 100-NFT page, every run restarts at start=0, and the fallback `ufc-enrichment-drain` has no caller since 10-18; 2 non-member wallets; fix designed in the filing, not shipped

## 2026-11-23 — 5 filings

- [✅ RESOLVED 11-24 (`20261123231928`, job 919 `cron_heavy`; 3:04 AM PT run succeeded, `last_vacuum` 3:05:42 AM PT) — Daytime monitor: pg_cron VACUUM job `maint-vacuum-panini-card-serials` (job 678) hit its first statement timeout at 19:04Z (5 prior runs ok) — known panini_card_serials growth/closing-margin class; suggest statement_timeout=0 on the VACUUM job, reversible](2026-11-23T2206Z-rpc-daytime-monitor-panini-card-serials-vacuum-statement-timeout.md) — 🔧 FIX APPLIED 2026-11-23 ~3:19 PM PT (Claude Code cloud, `20261123231928`): job moved to `cron_heavy` + MAINTAIN (jobid 919); the suggested `SET …;` prefix cannot run VACUUM. Verify the 11-24 3:04 AM PT run (focus.md) — ✅ VERIFIED 11-24 ~7:45 AM PT: run `succeeded`, `last_vacuum` 3:05 AM PT
- [✅ RESOLVED 11-23 ~7:06 PM PT (Cowork, SQL editor; 21 / 17 editions, 3 aliases, old URLs 308) — Claude Code → Cowork: one held DELETE (READY): merge two players split across a Jr./no-Jr. spelling — Candy "Luis Robert" + "Luis Robert Jr." (both White Sox, 19+2 editions), Panini "Andre Jackson" + "Andre Jackson Jr." (rookie cards, 4+13); SQL staged in docs/proposals, R153 pattern](2026-11-23T2145Z-claude-code-for-cowork-merge-two-split-suffix-players.md)
- [✅ RESOLVED 11-23 ~8:15 AM PT (`20261123154756`, `20261123154821`, `20261123154924`; #235 = enforcing; indexer 5 min, historical backfill paused) — Claude Code → Cowork: evening-pass hand-off — ⏰ retire two cadence bridges BEFORE 4 PM PT 11-23 + drop the stale challenges suppression (both held DELETEs, SQL in `2026-11-23T0200Z`), #235 firewall read (did `Entity page sweep` log or limit the 17-region sweep at 10:10 PM PT 11-16?), DROP the dead unscoped `check_set_completion(text)`, two cron-job.org changes awaiting Trevor's go, three dated reads](2026-11-23T1545Z-claude-code-for-cowork-evening-pass-open-items.md)
- [✅ RESOLVED 11-23 ~7:48 AM PT (`20261123154821`, `20261123154756`) — Claude Code → Cowork: two held DELETEs (READY, Trevor-approved; item 2 = retire two cadence bridges whose baseline is clean, due before 4 PM PT 11-23): drop the stale `ingest-topshot-challenges` alert suppression — its "redundant, 0 rows" claim is false (1,029 rows / 7 d via jobs 771/772) and it silences that lane's alerts until 12-04; the MCP held the DELETE three times, so run it in the SQL editor in Trevor's Chrome](2026-11-23T0200Z-claude-code-for-cowork-held-delete-stale-challenges-suppression.md)
- [✅ SELF-CLEARED 11-23 2:08 PM PT (#80 shed class; watchdog read `delivering`) — GHA schedule delivery stalled ~9.5h (last tick 09:50Z) — pg_cron watchdog correctly alarming (known-issues #80 class); 0 real cadence fallout (the one breach is the paused backfill lane), backstops holding; confirm GitHub-side shed vs broken workflow](2026-11-23T1913Z-rpc-daytime-monitor-gha-schedule-delivery-stalled.md) — ✅ RESOLVED 2026-11-23 2:08 PM PT: self-cleared (watchdog `delivering`, 0 breaches; paused lane un-watched `20261123220749`)

## 2026-11-22 — 1 filing

- [✅ RESOLVED 11-22 ~9:15 AM PT (`20261122170115`, per-wallet background cache) — `wallet_held_pack_value` times out (20 s) on large pack wallets: 4 PostgREST 500s since it shipped, one slow wallet per call (10.5–13.8 s warm on the biggest holders); honest (`walletsFailed`), three options for the owner](2026-11-22T0440Z-claude-code-wallet-held-pack-value-times-out-on-large-pack-wallets.md) — *(Claude Code cloud, ~8:40 PM PT 11-21, evening autonomous pass; not changed — the function was reshaped hours earlier by the sealed-pack thread.)*

## 2026-11-21 — 1 filing

- [✅ RESOLVED 11-20 — all three items closed (item 3 `20261121073043`, 11:30 PM PT) — Claude Code → Cowork: (1) ✅ APPLIED 11-20 ~8:46 PM PT by Cowork (`20261121044524`); was READY — retire the `candy-sales-indexer` zero-yield suppression (its own re-check condition fired; the MCP held the DELETE); (2) ✅ DONE 11-20 8:32 PM PT by Claude Code (`20261121043220`, Trevor approved) — null the Candy daily-market floors/listed counts 11-14 → 11-20 recorded off the ~9.3k phantom pre-migration asks (13,765 rows / 2,975 editions, user-facing market-history chart), SQL + backup + revert prepared; (3) OPTIONAL — 4 Candy bids from one probably-drained pre-lock wallet, checked 11-20: phantom (0 escrow), retire UPDATE awaits Trevor](2026-11-21T0315Z-claude-code-for-cowork-held-delete-and-candy-daily-cleanup.md)

## 2026-11-20 — 4 filings

- [✅ RESOLVED 11-20 ~11:21 AM PT (`20261120191551`, one listing id per distribution) — Daytime monitor — 2026-11-20 ~19:11Z: `rpc-allday-ev-corrected-refresh` pg_cron fails dup-key (dist 165) every 6h tick since 18:47Z — `pack_ev_latest` is DISTINCT ON (pack_listing_id) so 48 AllDay dists now have 2 rows and the MV's join on dist_id fans out into the CONCURRENTLY unique index; `mv_allday_pack_ev_corrected` frozen at the 12:47Z snapshot (HIGH). Plus HEAD `f6616b8` has no READY prod deploy — CANCELED, docs/db-only, zero user impact (LOW). Sweep clean: security 4/4 [], trust 41/41, stalled [], sentinel 0, 13/13 dashboards, client-beacon 0, not a spell](2026-11-20T1911Z-daytime-monitor-allday-ev-corrected-refresh-dupkey-pack-ev-latest-fanout.md)

- [✅ RESOLVED 11-20 6:42 AM PT (silence retired → `thin_since_2026_11_19`, migration `20261120144221`; remap self-heals 9:53 PM PT) — Daytime monitor — 2026-11-20 ~07:05Z: Candy revival trust arm BREACHES ($429.83 > $250) — Candy traded 44 sales/$411.85 on 11-19, the recorded 11-17 closure is stale (re-verify + re-date, arm working as designed); plus a one-off `rpc-topshot-misattrib-remap` IO-timeout at its quiet 05:53Z slot (missed one daily run). Both LOW/sense-only; security 4/4, stalled [], 0 HIGH alerts, 13/13 dashboards, Vercel 0 ERROR](2026-11-20T0705Z-daytime-monitor-candy-revival-breach-and-remap-io-timeout.md)

- [✅ CLOSED 11-19 ~6:35 PM PT by measurement (no winning shape; see the filing's Resolution) — Claude Code — `get_set_activity` pays ~45k buffers (cold 3.2 s, 8 s timeout) to find the 20 sales of a 4,088-edition Candy set; 5 separate honest "couldn't be loaded" degrades on /candy-mlb/set/2022-all-star-tricons in 48 h; three options measured; CLOSED not shipping — a general gate costs Top Shot 33k buffers/call (LOW)](2026-11-20T0005Z-claude-code-get-set-activity-sparse-wide-set-probes-every-edition.md)

- [✅ RESOLVED 11-19 (`20261119171500`, exhausted Atlas challenge caps at medium) — Daytime monitor — 2026-11-20 ~01:05Z: all green (security 4/4, trust 41/41, stalled [], UUID sentinel 0, 13/13 dashboards' objects resolve, Vercel 0 ERROR). One LOW candidate: `compute-pinnacle-pack-ev` is the sole HIGH failure_rate row, mostly the recovering #218 530 window + one Atlas 403 (newest run ok) — but its Atlas 403s still count as failures because the 11-19 challenge=retry fix skipped this lane](2026-11-20T0105Z-daytime-monitor-pinnacle-pack-ev-403-not-reclassified.md)

## 2026-11-19 — 4 filings

- [✅ RESOLVED 11-19 (`20261119110000` prefilter; 11-20 tick 33.4 s) — Daytime health monitor — 2026-11-19 ~16:05Z: all green (security 4/4, stalled [], 13/13 dashboards' objects resolve, prod 9b717e1 READY). One new pg_cron finding: `rpc-candy-wmc-ghost-purge` timed out once at 09:10Z after ≥8 clean daily runs — unscoped purge may be outgrowing its statement_timeout as Candy wmc grows (LOW, sense-only)](2026-11-19T1605Z-daytime-monitor-candy-wmc-ghost-purge-timeout.md)

- [✅ RESOLVED by observation 11-19 (arm ok; self-cleared with the #218 migration to Atlas) — Daytime health monitor — 2026-11-19 ~04:05Z: all green except pinnacle_render_floor_stale_hours trust BREACH (30.5h, new) — #218 Studio-530 keeps the floor writer from running; unlike the pack-sales arms it has no #218 ack/suppression → night-pass ack/suppress-or-accept decision (LOW, sense-only, self-clears on Studio recovery)](2026-11-19T0409Z-daytime-monitor-pinnacle-render-floor-218.md)

- [✅ RESOLVED 11-19 (revival arm sums USD, `20261119113000`; trophies filter in `get_insights_trophies`) — Claude Code — two measured proposals, not shipped: the Candy revival arm needs a re-date every ~4 days (count USD or 2026-set sales instead?), and /insights/trophies probes 8,106 wallet rows to show 1,209 (filter inside a function, keep the MATERIALIZED fence) (LOW)](2026-11-19T0200Z-claude-code-two-proposals-candy-revival-arm-and-trophies-probe.md)
- [✅ RESOLVED 11-19/11-20 (arm sums USD `20261119113000`; status re-verified `20261120144221`) — Daytime health monitor — 2026-11-19 ~01:05Z: all green (security 4/4, pg_cron [], stalled []); 13/13 dashboards' objects resolve; prod ccf94ca0 READY. Candy revival arm 11/10 BREACH = dust trickle, not a revival → re-verify + re-date (LOW); public_board_slow_count=1 is the known expected-empty pack-reality board; Studio-530 pack cluster ongoing ~24h (upstream)](2026-11-19T0105Z-daytime-monitor-candy-revival-dust-trickle.md)

## 2026-11-18 — 4 filings

- [✅ RESOLVED by observation 11-19 ~9:30 PM PT — schedules deliver again with multi-hour gaps; relay/probe/fallback cleanup stays ON HOLD — Daytime health monitor — 2026-11-18 ~16:10Z: all green (security/trust/pipelines/dashboards/deploy READY); GHA schedules dark again ~13h since 03:06Z — 11-17 "schedules back, cleanup owed" steer reversed, HOLD the relay/probe/fallback cleanup; gh api blocked in scheduled sessions (LOW, sense-only)](2026-11-18T1610Z-daytime-monitor.md)
- [✅ RESOLVED 11-18 (candy indexer cleared by itself, isolation already existed; pack-nft-identity applied) — Daytime health monitor — 2026-11-18 ~07:05Z: candy-sales-indexer later-set walk timeouts → candy_sales_stale BREACH (HIGH, new); pack-nft-identity ON CONFLICT escalated to every-tick (HIGH)](2026-11-18T0705Z-daytime-monitor.md)
- [✅ RESOLVED 11-18 (`20261118150441`) — Daytime health monitor — 2026-11-18 ~04:08Z: allday-pack-dist-totals sync null total_opened NOT-NULL violation, new since ~02:24Z, likely Studio-530 collateral exposing a missing null-guard (MED)](2026-11-18T0408Z-daytime-monitor.md)
- [✅ RESOLVED 11-18 ~7:13 AM PT (pack-nft-identity fix applied) — Daytime health monitor — 2026-11-18 ~01:10Z: pack-nft-identity ON CONFLICT dup-key (MED); TS pack-sales 530 blip (LOW)](2026-11-18T0110Z-daytime-monitor.md)

## 2026-11-17 — 3 filings
- [✅ RESOLVED 11-17 7:03 PM PT (schedules resumed; flaky since, see 11-18T1610Z) — Daytime monitor 2026-11-17 ~19:11Z — GHA scheduled workflows STILL dark (no schedule-tagged tick since 08:43Z; the ~16:35Z re-registration push did not take); 2 low-cadence lanes dark since ~02:00Z; data-freshness blast radius LOW (trust 42/42 ok); platform otherwise GREEN](2026-11-17T1911Z-daytime-monitor.md)
- [Claude Code → night pass: remaining acquisition dates (~11.3k undated pulls, ~18k held moments with no row across All Day / Pinnacle / UFC / Golazos, TS 110 + kind S) need Dune chain history — NOT before the Dune reset (Dec 13 4 PM PT); method + table inside](2026-11-17T0440Z-claude-code-acquisition-dates-remaining-needs-dune.md)
- [✅ RESOLVED 11-16 ~8:30 PM PT (`20261117044500`, 23,608 dated) — Claude Code → Cowork: APPLY the Trevor-approved Top Shot transfer-arrival-dates migration (`apply_topshot_arrival_transfers`, 23,608 held moments get their on-chain arrival date; method stays unknown) — two MCP applies timed out on the confirmation prompt; SQL + steps + revert inside](2026-11-17T0358Z-claude-code-for-cowork-topshot-transfer-arrival-dates.md)

## 2026-11-16 — 5 filings
- [✅ RESOLVED 11-16 ~9:38 PM PT (recipes `20261117052750`; inner-pack 30-day park fixed `20261117053146`) — Daytime monitor 2026-11-16 ~19:10Z — platform GREEN; new trust breach topshot_container_missing_recipe_count=2 (WNBA Finals Box 8934 + Case 8933, ~0.7 h old, both have descriptions): seed description recipes per the drop-day runbook so they get Rip EV](2026-11-16T1910Z-daytime-monitor.md)
- [✅ RESOLVED (C1 by the #248 close-out 11-16 10:20 AM PT; C2 answered, arm `ok` 10:34 AM PT) — Daytime monitor 2026-11-16 ~07:05Z — wmc-fmv fast-lane timeout onset (11-14 #248 apply) + candy_sales_stale arm still breaching after the 11-15 redesign](2026-11-16T0705Z-daytime-monitor.md)

- [✅ RESOLVED by observation (one-off; 06:28Z 886 ms, slow_count 0) — daytime-monitor -> night pass: candy_secondary_board liveness 15.6 s vs 3 s budget (public_board_slow breach=1); board still renders fully (21,472 rows) — re-measure, then add index or re-baseline max_ms](2026-11-16T0410Z-daytime-monitor-candy-secondary-board-liveness-slow.md)
- [✅ RESOLVED 11-15 ~8:41 PM PT (#259 shipped `79c7bcece` + `20261116043431`; re-measured 11-17 1:55 PM PT: 0 editions / 0 cards over circulation) — Claude Code → Trevor: 90 Candy editions merge DIFFERENT cards (42,592 holdings; 3,857 serials above circulation) — Play of the Day date-strip bug, AL/NL Helmet, DC printings, cut ticket names; proposal: key by rarity + denominator, re-key via the 11-09 machinery + aliases; NOT applied](2026-11-16T0404Z-claude-code-for-trevor-candy-merged-multi-mint-editions.md) — ✅ ACTED ON 2026-11-15 ~8:41 PM PT (`79c7bcece`, migration `20261116043431`; watching)
- [✅ RESOLVED 11-15 (~6:00 PM PT batched chain script + parallel keys; names kept from chain 10:08 PM PT, Trevor delegated) — Claude Code → Trevor: wallet search could answer in ~1–2 s instead of 7–15 s by reading moment metadata from wallet_moments_cache, but 127/264 rows match the chain exactly (214/264 excluding circulation; cache names are often the site's canonical ones) — product call on which circulation/name to show; NOT changed](2026-11-16T0058Z-claude-code-for-trevor-wallet-search-cache-first-metadata.md) — ✅ RESOLVED 2026-11-15 ~6:00 PM PT (Claude Code): chain circulation is the whole family (a /500 parallel read 16,000), so circulation now comes from the edition row; parallels keyed set:play::N, priced by their own edition; chain read batched 25/script. Names unchanged (cache-first not needed)

## 2026-11-15 — 7 filings

- [Claude Code → Trevor: `pack_ev_history` grows ~187k rows/week and 77 % repeat the previous snapshot exactly — proposal to thin old identical runs (keeps every value change and each pack's latest row) + a weekly job; count-based readers must be checked first; ~1M-row DELETE, NOT applied](2026-11-15T2311Z-claude-code-for-trevor-pack-ev-history-identical-runs.md) — ✅ RESOLVED 2026-11-15 ~5:55 PM PT (Claude Code): 20261116014326 — 691,464 interior identical rows thinned (1.41M → 723k), newest/filtered/hourly reads proven identical; daily pg_cron 889 keeps it thinned; backup audit_20261115_pack_ev_history_thinned

- [Claude Code → Cowork/Trevor: the #248 fast-lane fix FAILED its pre-registered cost bar (3 h pooled 9,146 PostgREST reads/call vs 7,195) — revert to the 08-30 body + job 617 back to 2-hourly staged in docs/proposals/, NOT applied (destructive-statement prompt unanswered); needs Trevor's yes](2026-11-15T2040Z-claude-code-for-cowork-revert-rwfc-to-0830-body.md) — ✅ DONE 2026-11-15 (Claude Code cloud, Trevor delegated): NOT reverted — fix + daily 617 is net-negative IO; job 446 stale-overwrite fixed in 20261115204212

- [Claude Code → Cowork: three staged migrations — analytics_pipeline_health sales leg uses an index (D4 500s), get_hybrid_custody_candidates 90 s timeout, R153 player spelling merges + 48 Panini country duplicates — each needs Trevor's go-ahead; staged in docs/proposals/](2026-11-15T1635Z-claude-code-for-cowork-apply-three-staged-migrations.md) — ✅ ALL APPLIED: #1 `20261115172732`, #2 `20261115172736` (Claude Code 9:27 AM PT), #3 R153 `20261115183435` (Cowork SQL editor 10:34 AM PT)

- [`candy_sales_stale_hours` BREACH is not clearing — the legacy-collections census is an ONGOING backfill source (queued_collections_walk parked 2,634→3,898 since 09:05Z), overtaking the "clears by noon PT" disposition; + untracked hybrid_custody_backfill timeouts](2026-11-15T1604Z-daytime-monitor-candy-sales-unresolved-backlog-growing-not-clearing.md) — candidate 2 staged in 2026-11-15T1635Z §2; ✅ candidate 1 DONE 2026-11-15 ~2:18 PM PT (Claude Code cloud): untried queued_collections_walk rows leave the >50 arm, new 6 h drain-stall arm (`20261115221844`)

- [Claude Code → Cowork: drop the parked `sets_summary_prev_20261114` in the Supabase SQL editor (Trevor approved; the connector's DROP confirmation timed out 3×) — guard + DROP + history row, read back, commit the migration file, close #255](2026-11-15T0506Z-claude-code-for-cowork-drop-parked-sets-summary-prev.md) — ✅ DONE 2026-11-15 ~10:35 AM PT (Cowork, SQL editor): dropped as `20261115183513`, #255 closed

- [Claude Code → Cowork: apply the FMV activity-gap snapshot (`fmv_activity_gap` + pg_cron `rpc-fmv-activity-gap`) — the destructive-statement prompt went unanswered twice, nothing applied; staged in docs/proposals/fmv-activity-gap-STAGED.sql — and verify the first legacy-listings runs (#257), diff the two Project-only ME files against what the walk queued, confirm OpenSea's Solana program id from an official source (#256)](2026-11-15T0500Z-claude-code-for-cowork-apply-fmv-activity-gap.md) — ✅ steps 1–4 DONE 2026-11-14 ~8:58 PM PT by Claude Code (`20261115045831`, applied without a prompt); ✅ steps 5 & 6 DONE + step 7 answered 2026-11-15 ~8:20 AM PT by Claude Code (see the filing; #256/#257 carry the follow-ups)

- [Candy secondary trading is reviving past the 11-10 "silent_since" disposition — 9 sales since baseline (7 in 48 h), revival counter 9/10](2026-11-15T0410Z-daytime-monitor-candy-revival-overtaking-silent-since-1110-disposition.md) — ✅ RESOLVED 2026-11-14 8:20 PM PT (Claude Code): still a trickle (0 of 9 in a 2026 set) → re-dated silent_since_2026_11_14 (20261115041831), arm 0/10; the stale-hours BREACH is 1,175 historical sales queued by a first full-feed walk, draining 300/tick

## 2026-11-14 — 7 filings
- [✅ RESOLVED 11-14 (`20261114221716` + class fix `20261114225500`) — Daytime monitor (22:11Z) — `board_mv_refresh_stale_hours` false BREACH (2502.8h) from TODAYS OWN ship (migration `20261114212002`): the perfect-mint MV refresh was repointed to a wrapper fn whose name lacks the `mv_` literal, so `board_mv_refresh_max_stale_hours()` ILIKE-join misses → falls back to watchlisted_at. Board is FRESH (43 rows, refreshed 22:00Z; cadence-watchlist now covers it). LOW blast radius, HIGH cry-wolf cost. Night-pass fix: teach the join the refresh-fn spelling, or inline the MV name as a comment in job 236. Otherwise GREEN: security x4 clean, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, prod READY, no spell](2026-11-14T2211Z-daytime-monitor-board-mv-refresh-false-breach-perfect-mint.md)
- [✅ RESOLVED 11-14 (comment-exempt `20261114192649`) — Daytime monitor (19:05Z) — `alert_sub_is_exact_serial(int,int,uuid[])` (new in todays exact-serial pass-3 ship) has a mutable search_path (`function_search_path_mutable` advisory); SECURITY INVOKER so advisory-only, not escalation. Night-pass fix: ALTER … SET search_path, or the 20261026001400 comment-exempt path — MEASURE inlining cost first (per-row helper in the dispatcher). Otherwise GREEN: security x4 clean, trust 0 breaches, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, prod READY](2026-11-14T1905Z-daytime-monitor-alert-sub-is-exact-serial-search-path.md)
- [Claude Code → Cowork: apply the #248 fast-lane fix (refresh_wmc_fmv_changed drops only what it applied + confidence + 5-min cursor overlap) — the destructive-statement prompt went unanswered twice, nothing applied; staged in docs/proposals/](2026-11-14T1710Z-claude-code-for-cowork-apply-rwfc-drops-only-what-it-applied.md) — ✅ DONE 2026-11-14 (Cowork via Chrome SQL editor): applied as 20261114171317, repo half pushed
- [Daytime monitor (07:09Z) — `atlas-market-events-prune` began throwing `deadlock detected` (40P01) today: 2/48 runs (01:27Z, 05:27Z), none in the prior 48h; LOW, harmless/self-retrying (rolls back, re-prunes next tick), not stalled, not a spell — candidate for night-pass lock-order/SKIP LOCKED fix after confirming the lock partner. Otherwise GREEN: security x4 clean, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, trust 0 breaches, cross-collection fresh, prod READY](2026-11-14T0709Z-daytime-monitor-atlas-market-events-prune-deadlock.md) — ✅ DONE 2026-11-15 (Claude Code cloud, #248 watch): fixed by 20261114153229 (FOR UPDATE SKIP LOCKED); 26/26 runs clean since the 11-14 7:33 AM PT apply, 0 deadlocks (pre-fix 2/48)
- [Claude Code → Cowork: add a Vercel firewall rule that CHALLENGES the Tencent Cloud scraper (AS 132203/45090; ~1.49M requests since 11-09 across every page type, only ~37k challenged by the entity-path rule) — #235](2026-11-14T0420Z-claude-code-for-cowork-firewall-challenge-tencent-cloud-scraper.md) — ✅ DONE 2026-11-14 (Cowork via Chrome): Challenge rule on AS 132203/45090 published
- [Claude Code → Cowork: apply the #247 alias-edition retirement (skip re-insert of alias keys + delete emptied alias editions, cron) — the destructive-statement prompt went unanswered twice, nothing applied; staged in docs/proposals/](2026-11-14T0120Z-claude-code-for-cowork-apply-candy-alias-editions-retired.md) — ✅ APPLIED 2026-11-13 ~5:40 PM PT by Cowork (`20261114013700`)
- [Claude Code → Cowork: apply the Candy edition-key aliases (#247) — one canonical key per card; the destructive-statement prompt went unanswered twice, nothing applied; SQL, repo patch and schedule staged in docs/proposals/](2026-11-14T0020Z-claude-code-for-cowork-apply-candy-edition-key-aliases.md) — ✅ DONE 2026-11-13 ~4:45 PM PT (Cowork, SQL editor): applied as 20261114002600 — open — ✅ APPLIED 2026-11-13 ~4:22–4:45 PM PT by Cowork (`20261114002600`)

## 2026-11-13 — 4 filings
- [Daytime monitor (04:05Z) — `topshot-active-listings-ingest-backstop` hit `egress_blocked` once (1/7d), no freshness impact; otherwise GREEN (security x4, stalled/pg_cron/sentinel clean, 13/13 dashboards, trust 1 known breach edition_integrity_flags falling, prod READY)](2026-11-13T0411Z-daytime-monitor-topshot-active-listings-backstop-egress-blocked-once.md)
- [Daytime monitor (07:06Z) — weekly `net._http_response` size read is overdue (focus steer scheduled ~11-11, last measured 11-03); LOW read-only re-measure. Otherwise GREEN: security x4 clean, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, trust 1 known breach (edition_integrity_flags falling), prod READY](2026-11-13T0706Z-daytime-monitor-net-http-response-weekly-size-read-overdue.md) — ✅ RESOLVED 2026-11-13 3:23 PM PT (Cowork): 2,075 MB total / 693 MB live bodies, oldest 6 h — down from 3,033 / 855 on 11-03; TTL working, no action
- [Claude Code → Cowork: apply the Candy integrity-residual migration in the dashboard SQL editor (destructive-statement prompt went unanswered twice; staged in docs/proposals/) — takes edition_integrity_flags 34 → ~8](2026-11-13T1704Z-claude-code-for-cowork-apply-candy-integrity-residual.md) — ✅ APPLIED 2026-11-13 ~11:56 AM PT by Cowork (`20261113200000`)
- [Daytime monitor (22:06Z) — franchise-hub `get_team_activity` still cold-times-out after the 11-12 `/teams` prefetch fix (45 s RPC no-response + a 10 s detroit-lions panel read at ~12:00Z, both post-close); LOW read-only quiet-window re-measure per the 11-12 item's own falsifier. Otherwise GREEN: security x4 clean, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, trust 0 breaches, prod READY](2026-11-13T2206Z-daytime-monitor-franchise-hub-get-team-activity-post-fix-recurrence.md) — ✅ RESOLVED 2026-11-13 3:25 PM PT (Cowork): the read is not the lever — EXPLAIN ANALYZE BUFFERS 43 ms / 5.8k buffers (AD detroit-lions), 152 ms / 6.9k (TS lakers); the 4 AM PT timeouts were a concurrent cold sweep, not query cost

## 2026-11-12 — 2 filings
- [Claude Code → Cowork: DROP the retired Panini squeeze MV `mv_panini_squeeze_retired_20261110` in the dashboard SQL editor (destructive-statement prompt went unanswered)](2026-11-12T0640Z-claude-code-for-cowork-drop-retired-panini-squeeze-mv.md) — ✅ APPLIED 2026-11-12 ~7:05 AM PT by Cowork (`20261112150101`)
- [✅ RESOLVED 2026-11-12 ~5:15 PM PT (0 franchise-panel timeouts after the fix) — Daytime monitor -- verify today's /teams prefetch fix (aa6af0f6, prod ~18:22Z 11-12) cleared the franchise-hub panel 10s read-timeout cluster (15:53Z, >=4 NBA teams); if the per-panel read still cold-times-out post-fix, size it -- not a spell (io_wait 0). Otherwise GREEN: security x4 clean, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, trust 1 known breach (edition_integrity_flags falling), prod READY](2026-11-12T1907Z-daytime-monitor-verify-teams-prefetch-fix-cleared-franchise-hub-panel-10s-timeouts.md)

## 2026-11-11 — 2 filings
- [Daytime monitor — `candy-editions-ingest` fails daily at the 01:10Z tick on a `wallet_moments_cache` lock timeout, self-heals at 04:10Z (otherwise GREEN: security/stalled/sentinel clean, 13/13 dashboards, prod serving latest app code)](2026-11-11T0715Z-daytime-monitor-candy-editions-ingest-0110z-lock-timeout.md) — ✅ RESOLVED (re-checked 11-15): 6/6 ticks ok 11-12 → 11-14, 01:10Z included
- [✅ RESOLVED (item 1 `20261111014609`, ok ×2; item 2 fixed at the record, 11-11 ~6:10 PM PT) — Daytime monitor — fmv-backfill still tips the 60s statement-timeout on ~1/3 of runs post the 11-10 fix; wallet-backfill-continuation arm reads HIGH on the already-recovered #245 lane](2026-11-11T0112Z-daytime-monitor-fmv-backfill-tips-60s-and-continuation-arm-reads-high.md)

## 2026-11-10 — 13 filings
- [✅ RESOLVED (Cowork applied `20261110230100`; part B by Claude Code `20261110225146`; drain priced 581 by 7:20 PM PT 11-10) — Claude Code → Cowork: apply `sol_usd_daily` in the dashboard SQL editor — 2,528 Candy sales parked `no_sol_rate` (runbook docs/handoff-2026-11-10d-cowork-apply-sol-usd-daily.md)](2026-11-10T2245Z-claude-code-for-cowork-apply-sol-usd-daily.md)
- [✅ RESOLVED (`20261110195805` + `20261110200203`: picker skips asks, sets read scoped to one product, covering owner index — 84 s → 0.17 s for the largest holder) — `panini-set-progress-products` read-timeout — Panini sibling of the All Day set-progress full-FMV read (1715Z)](2026-11-10T1910Z-daytime-monitor-panini-set-progress-read-timeout-same-class-as-allday.md)
- [Withdrawn prices — population sweep: UFC tracker fix staged (latent), seven cached-price readers left as a recorded choice, the rest clean](2026-11-10T1840Z-withdrawn-prices-population-sweep-ufc-tracker-staged-seven-cache-readers.md) — ✅ §1 APPLIED 11-10 (`20261110184532`, Claude Code); re-checked 11-15 — *(Cowork cloud, read-only.)* Checklists, platform stats, tier pulse, the three deal boards and Panini's views read clean; 8 moments / $442 among signed-up users' wallets still show a last-known price unmarked.
- [✅ RESOLVED (`20261110170308`: estimates heights only for new sold moments; job 638 re-run 9:05 AM PT) — daytime monitor — rpc-chain-arrivals-seed newly timing out (flow_height_estimate DISTINCT over growing puller wallets); green the prior 5 days](2026-11-10T1607Z-daytime-monitor-chain-arrivals-seed-timeout.md)
- [✅ RESOLVED (`20261110181426`: five wallet readers count a withdrawn cached price as stale; acceptance passed) — Wallet caches keep prices the engine has withdrawn — $89,860 across 474 moments in 79 wallets; no writer can carry a NULL](2026-11-10T1800Z-wallet-caches-keep-prices-the-engine-withdrew.md) — *(Cowork cloud, read-only.)* All Day 432 rows / 48 wallets / $69,987; Top Shot 42 / 31 / $19,873; every row still priced. Needs a decision: re-label as stale, or clear the price.
- [✅ RESOLVED (`20261110173413`: both set functions read `edition_fmv_current`; 3.7 s → 0.26 s, withdrawn prices no longer counted) — `get_allday_set_progress` streams every All Day FMV snapshot on each call — 8 s read budget missed cold; the cached table is NOT a drop-in](2026-11-10T1715Z-allday-set-progress-reads-the-whole-fmv-snapshot-set-per-call.md) — *(Cowork cloud, read-only.)* 63,233 buffers per call; `edition_fmv_current` differs on 196 editions (latest non-null vs latest). Also: Fast Break still parked; "Candy MLB" label kept.
- [✅ RESOLVED (`20261110225146`: one $0.17 sale + 4 dust = a trickle; silence re-verified and re-dated to 11-10, arm 0) — Candy revival detector fired: first Candy sale since 10-11 (a legacy collection, $0.17)](2026-11-10T0645Z-candy-revival-detector-fired-first-sale-since-10-11.md)
- [Claude Code: watch list for the 11-09 signup-wave thread (archived) — self-heal lanes, #242 24 h exit, Candy 1-of-1 re-key + orphan cleanup, candy-editions-ingest lock timeout](2026-11-10T0552Z-claude-code-watch-list-for-the-11-09-signup-wave-thread.md)
- [✅ RESOLVED (`45bae3819` + `20261110044500`: listings follow the repointed card) — Cowork → Claude Code: retired candy_listings rows keep the old edition after a Candy 1/1 re-key; orphan cleanup skips them (11 on the first tick)](2026-11-10T0430Z-cowork-for-claude-code-candy-listings-keep-old-edition-after-1of1-rekey.md)
- [✅ Claude Code → Cowork: Candy trophies = MLB only (Trevor) + hourly cleanup of orphaned Candy 1/1 editions — runbook docs/handoff-2026-11-09c-cowork-candy-trophies-and-orphans.md](2026-11-10T0359Z-claude-code-for-cowork-candy-trophies-mlb-only-and-orphan-cleanup.md)
- [✅ Claude Code: 183 Candy editions labelled 1-of-1 but held more than once (Tricons name truncation; Bat Cowl 4,404 held) show as "1 of 1" on /insights/trophies — census owner](2026-11-10T0318Z-claude-code-candy-false-one-of-ones-on-trophies-board.md)
- [✅ Claude Code → Cowork: #242 second step — apply the rotated-slice migration (5:53 PM backfill 40.6 s; unpriced leg still probes all 33,716 queued rows) — runbook docs/handoff-2026-11-09b-cowork-apply-rotated-slice.md](2026-11-10T0202Z-claude-code-for-cowork-apply-rip-metadata-rotated-slice.md)
- [✅ Claude Code → Cowork: apply two staged SQL migrations in the dashboard SQL editor (#242 rip-metadata eligibility precompute; wmc selfheal skips Candy + Atlas reconcile 300 s) — runbook docs/handoff-2026-11-09-cowork-apply-staged-sql.md](2026-11-10T0039Z-claude-code-for-cowork-apply-two-staged-sql-migrations.md)

## 2026-11-09 — 6 filings
- [✅ daytime monitor — wmc three-lane timeout is STRUCTURAL (wmc +1.4M rows, stats NULL), diagnosis of the 16:06Z cluster](2026-11-09T2211Z-daytime-monitor-wmc-three-lane-timeout-is-structural-not-transient.md)
- [✅ gha-schedule-watchdog: no GHA schedule-tagged tick since 09:59Z (~8.6h, watch); rest of sweep green](2026-11-09T1909Z.md)
- [✅ daytime monitor: morning statement-timeout cluster on 3 wmc/editions self-heal lanes (symptom)](2026-11-09T1606Z-daytime-monitor-wmc-editions-statement-timeout-cluster.md)

- [✅ Daytime monitor 2026-11-09T01:05Z — edition_integrity_flags 250→10392 (NEW breach): 10,370 from the 11-08 Candy census (tier/circulation/thumbnail absent on fresh non-registry editions), same fail-safe class as the drained 09-30 Panini case; the other 4 Candy-closure breaches already filed 22:05Z](2026-11-09T0105Z-daytime-monitor-candy-census-edition-integrity-breach.md)
- [✅ Daytime monitor 2026-11-09T04:12Z — SYMPTOM (saturation spell, 15/15 IO wait): backfill-pack-rip-metadata timing out 6h (post census-slot-move fix) + rpc-candy-wmc-label-fill pg_cron timing out; both statement-timeout collateral, cause deferred to a quiet-window re-measure](2026-11-09T0412Z-daytime-monitor-saturation-spell-ripmetadata-labelfill-timeouts.md)
- [✅ Daytime monitor 2026-11-09T07:08Z — candy-collections-census failed its last 4 runs (3 clean before); ghost-purge timeout fixed overnight (20261109044509) but 2 post-spell fails wedge on "2022 Leadoff ICONs page 66" (local stmt-timeout + upstream DAS); gates the open edition_integrity drain — night pass to confirm it resumes](2026-11-09T0708Z-daytime-monitor-candy-census-recent-run-failures.md)

## 2026-11-08 — 7 filings

- [✅ Daytime monitor candidates — 2026-11-08T22:05Z (≈2:05 PM PT): candy-sales-indexer ME offset-15500 bug, Candy revival re-verify, candy_offer_spread_board calibration](2026-11-08T2205Z-daytime-monitor.md)
- [🟠 **FOR TREVOR (later)** — switch the "Entity page sweep" Vercel firewall rule from Log to Challenge (#235; 300 req/60 s per JA4, logging 212/day), and pick a display name for alaskanninja](2026-11-08T1712Z-cowork-for-trevor-firewall-sweep-rule-to-challenge-and-alaskanninja-name.md)
- [✅ 🟠 **FOR COWORK** — apply the trophy picker "Load more" migration (`20261108155000_audit_20261108_trophy_picker_load_more_offset.sql`, DROPs the 5-arg `get_user_top_owned_moments` → 6-arg with `p_offset`) in the SQL editor, then cherry-pick the parked code commit `b08918dfc` from `claude/epic-carson-7x3ok7` onto `main`; Claude Code's apply was held twice](2026-11-08T1558Z-claude-code-apply-for-cowork-trophy-picker-load-more.md)
- [✅ 🟠 **FOR CLAUDE CODE / COWORK** — delete the OLD laptop-pull scheduled task `trig_014mdFHh2m4AYTkYLTF7XxSV` before 11-09 5:37 AM PT; its device-bound replacement `trig_015m2ZbNHoNmtT7ExQAQeVJD` exists (the old one stalled 11-08 waiting for folder access)](2026-11-08T1524Z-cowork-for-claude-code-or-cowork-delete-old-laptop-pull-task.md)
- [✅ 🟢 **FOR COWORK** — drop the scratch table `public.zz_pgss_probe_20261108` (Claude Code's pg_stat_statements delta probe; RLS on, no grants, no dependents; guarded SQL inside; Claude Code's DROP was held)](2026-11-08T1509Z-claude-code-drop-for-cowork-zz-pgss-probe-scratch-table.md)
- [✅ 🟠 **FOR COWORK** — apply the committed trophy-case cap trigger migration (`20261108002000_audit_20261107_trophy_cases_extra_cap_enforced_in_db.sql`); Claude Code's apply was held; route half shipped and dormant](2026-11-08T0025Z-claude-code-apply-for-cowork-trophy-cases-extra-cap-trigger.md)
- [✅ 🟠 **FOR COWORK** — two placeholder rows from the wallet-search seed bug: rename edition `85:2918` → "Brooklyn Nets — Dynamic Duos", delete the unreferenced player "Unknown (error loading)" (guarded SQL inside; Claude Code's MCP could not apply it)](2026-11-08T0002Z-claude-code-data-fix-for-cowork-unknown-error-loading-edition-and-player.md)

## 2026-11-07 — 1 filing

- [🟢 **ACCEPT 11-07 (nightly pass): 0.889 — LOW tier is the by-design 0.75× haircut, 30-d 1.000; steer closed.** All Day 7-d published FMV/sale ratio 0.882–0.899 — marginally under the 0.90 action line the 11-04 steer set (LOW tier the driver; 30-d still 1.000; benign, re-derive/decide)](2026-11-07T0409Z-daytime-monitor-allday-7d-fmv-sale-ratio-marginally-under-090-action-line.md)

## 2026-11-06 — 4 filings

- [🟢 **VERIFIED 11-07 ~10:55 AM PT — green from the first run after `cfa4711` (00:15Z, `e8ca0d6`) and every run since; closed.** E2E DOM Smoke red on batch-1 band suppression — verify the cfa4711 re-pin cleared it (benign; GHA unreadable here)](2026-11-06T2205Z-daytime-monitor-e2e-dom-smoke-band-repin-verify.md)
- [Scheduler-liveness check reds `main` daily — new weekly `cadence-swap-lint.yml` has no scheduled run yet (benign; first slot Mon 11-09)](2026-11-06T1610Z-daytime-monitor-scheduler-liveness-red-on-new-weekly-cadence-swap-lint.md)
- [public_board_empty_count BREACH — topshot_perfect_mint_premiums_board liveness floor too tight for a market-driven board (benign, no dark surface)](2026-11-06T0414Z-daytime-monitor-perfect-mint-premiums-board-liveness-floor-too-tight-benign-breach.md)
- [`topshot_sold_floor_asks_found` trust arm false-positive BREACH — breach_at 50 at the pre-clear sawtooth peak (value 54 -> 30 self-cleared; LOW tuning)](2026-11-06T0109Z-daytime-monitor-topshot-sold-floor-asks-found-threshold-near-sawtooth-peak.md)

## 2026-11-05 — 1 filing

- [✅ refresh-conflated-editions cron-job.org route silent since 2026-11-03 15:17Z — missed its 11-04 daily tick (conflated guard fresh, thin-FMV 16.6h stale, MEDIUM)](2026-11-05T0105Z-daytime-monitor-refresh-conflated-editions-route-silent-missed-1104-tick.md)

## 2026-11-04 — 2 filings

- [✅ Measurements owed after SQL was blocked mid-turn: ts_listings NULL-series incidence (sniper fixes), the staged index swap, the restarted #228 watch](2026-11-04T0611Z-claude-code-measurements-owed-after-sql-was-blocked.md)
- [✅ #228 /api/collection-snapshot RPC_READ_TIMEOUT recurred ~15 min after the covering-index fix landed — the APPLIED watch falsifier tripped; re-measure the cold whale read](2026-11-04T0410Z-daytime-monitor-228-collection-snapshot-timeout-recurred-post-fix.md)

## 2026-11-03 — 1 filing

- [🟢 net._http_response at 2,591 MB exceeds its documented ~1,910 MB sawtooth peak — re-measure prune cadence (SYMPTOM, not a leak claim)](2026-11-03T0705Z-daytime-monitor-net-http-response-above-documented-sawtooth-peak.md)

## 2026-11-02 — 3 filings

- [Artifact-validation roster (#114) lists 11 dashboards but 16 ported sources exist in docs/cowork-skills/ — all 16 validate clean](2026-11-02T0713Z-daytime-monitor-artifact-validation-roster-drift-11-vs-16.md)
- [Panini ingest throughput down + old catalogue starving — read-only diagnosis (laptop runner firing but doing too little per walk; 14,576 editions un-repriced 7+ days), needs Claude Code/Trevor](2026-11-02T1900Z-panini-ingest-throughput-down-old-catalogue-starving.md)
- [GitHub Actions delivered no schedule-tagged tick in ~9h (since 09:58Z); gha-schedule-watchdog red since 16:08Z, 0 cadence lanes breaching — no data loss yet](2026-11-02T1908Z-daytime-monitor-gha-schedule-tick-stall.md)

## 2026-11-01 — 1 filing

- [panini-ingest-enum silent ~947min (> 246min historical max) on quiet Sunday — downstream FMV fresh, verify watch threshold](2026-11-01T1545Z-daytime-monitor-panini-ingest-enum-silent-beyond-historical-max-gap.md)

## 2026-10-29 — 3 filings

- [✅ RESOLVED by the lane itself (notice lifted 10-29 ~10:57 AM PT on Top Shot's own sales under `20261029025944`'s per-collection rule; all four rows `healthy`, no `marketplace_saved`, the restore cron unscheduled — re-read 10-30 ~10:40 PM PT, Cowork cloud) — was: 🔴 Daytime monitor (10-29 ~06:13Z, infra GREEN, trust 39/39 ok, 11/11 dashboard objects OK, not a spell) — Dapper "degraded / can't buy" notice STUCK on Top Shot (last_verified 02:59Z) while TS is trading LIVE (10 sales/70min, newest 06:00Z) and atlas-market-feed solid 500-600 rows/tick since 05:11Z; restore cron fires+succeeds every 10min but won't re-lift (it DID lift at 00:16Z = a flap); buy CTAs actually enabled; backstop ~07:00Z 10-30 — HIGH user-facing accuracy, flagship](2026-10-29T0613Z-daytime-monitor-dapper-maintenance-notice-stuck-degraded-while-topshot-trading-live.md)

- [✅ RESOLVED (recovery confirmed; the one lane that did not resume was retired 10-30 with Flowty — re-read 10-30 ~10:40 PM PT, Cowork cloud) — was: 🟢 Daytime monitor (10-29 ~00:16Z, infra GREEN, trust 39/39, 16/16 dashboard objects OK) — Dapper outage RECOVERED + maintenance notice correctly auto-lifted (marketplaces → healthy), but 2 TS listing lanes not yet resumed: topshot-listing-cache 0-success ~20h (page-0 HTTP 500), topshot-active-listings-ingest silent ~8h (<15h threshold) — confirm recovery, WATCH/LOW](2026-10-29T0015Z-daytime-monitor-topshot-listing-lanes-dark-after-dapper-notice-lifted.md)

- [✅ RESOLVED 10-30 (the lane was RETIRED with the Flowty teardown, `f01690f` 10:48 AM PT — it could not self-heal because its upstream was gone; re-read 10-30 ~10:40 PM PT, Cowork cloud) — was: 🟢 Daytime monitor (10-29 ~03:14Z, infra GREEN, trust 0 breaches, 16/16 dashboard objects OK) — follow-up to 00:15Z: topshot-listing-cache did NOT self-heal (still 0-success ~23h, page-0 HTTP 500, atlas healthy since 00:10Z = distinct break); TS asks actually FRESH via ts_listings; real stale ask-input surface is cached_listings_v2 AllDay/Golazos/Pinnacle ~35h (AllDay+Pinnacle known Dapper-maintenance; Golazos verify), invisible to the fmv_stale gate — WATCH/LOW](2026-10-29T0314Z-daytime-monitor-topshot-listing-cache-not-self-healing-and-ask-input-scope.md)

## 2026-10-28 — 2 filings

- [✅ DISPOSITIONED 10-31 (re-measured: :06 is BELOW the median minute, 1,512 starts vs 1,800; the 10 timeouts were one minute on the Dapper-outage day; no stagger) · 🟢 Daytime monitor (10-28 ~18:06Z, infra GREEN, 16/16 dashboard objects OK, not a spell) — single isolated pg_cron "job startup timeout" cluster at the :06 minute (10 jobs, 18:00Z hour only; 0 in every other hour across 12h, 0 logic errors); transient bgworker-slot pile-up, likely amplified by Dapper-outage HTTP retries — SYMPTOM, quiet-window re-measure, LOW](2026-10-28T1810Z-daytime-monitor-pgcron-startup-timeout-06min-blip.md)

- [🔴 Daytime monitor (10-28 ~03:12Z) ESCALATION of 2026-10-27T1809Z — all three Top Shot Atlas lanes STILL fully dark ~10h (since 17:03Z); upstream 502 persists (609/3h market lane, newest 03:12Z), NOT recovered; Top Shot market/edition/sale freshness ~10h stale (newest sale 16:54Z); the 18:09Z "verify recovery" is a NO — HIGH(freshness)/upstream](2026-10-28T0312Z-daytime-monitor-topshot-atlas-lanes-STILL-DARK-10h-502-escalation.md)

## 2026-10-27 — 2 filings

- [🔴 Daytime monitor (10-27 ~18:09Z) — Atlas upstream 502 froze all three Top Shot Atlas lanes (market-feed / editions-refresh / pack-supply) since ~17:03Z; atlas-market-upstream-403 arm at HIGH on freshness; origin-down 502, no rows lost, verify recovery — HIGH(freshness)/upstream](2026-10-27T1809Z-atlas-upstream-502-all-three-topshot-lanes-frozen.md)

- [✅ RESOLVED 10-27 ~7:45 AM PT (Claude Code cloud; `20261027140941` + `9f5cb7912`: Top Shot and Panini read a snapshot like All Day) — was: 🟢 Daytime monitor (10-27 ~03:09Z, infra GREEN, dashboard objects OK) — hot-floors board reads exceed the 8s read-bound on TODAY's all-day/Panini Top Shot-parity deploy (allday-hot-floors + panini-hot-floors, both first-seen today on dpl_5gW6jqNC a33bf9e8); degrades to empty, count 1 each — LOW, recent-ship perf watch](2026-10-27T0309Z-daytime-monitor-hot-floors-read-bound-allday-panini-parity.md)

## 2026-10-26 — 3 filings

- [🟢 Daytime monitor (10-26 ~21:08Z, infra GREEN, 11/11 dashboards OK) — candy-upstream timeout cluster: candy-listings 3 consecutive (12:35/15:35/18:35Z) + sales 12:20Z + offers 18:50Z — shared upstream latency, NOT listings-only, NOT a DB spell; LOW, follow-up to the 18:06Z filing](2026-10-26T2112Z-daytime-monitor-candy-listings-indexer-afternoon-upstream-timeout-cluster.md)

- [✅ RESOLVED 10-25 ~5:20 PM PT by a curated exemption, NOT the ALTER (pinning stops inlining, 13× slower; `20261026001535`) — was: 🟢 Daytime monitor (10-26 ~00:06Z, infra GREEN, 11/11 dashboards OK) — recent_low_usd(numeric,numeric) shipped unpinned; function_search_path_drift non-empty for the first time since the two residual COMMIT procedures (pin via ALTER SET search_path)](2026-10-26T0006Z-daytime-monitor-recent-low-usd-search-path-unpinned.md)
- [🟢 Daytime monitor (10-26 ~18:06Z, infra GREEN, 11/11 dashboards OK) — candy-listings-indexer 2 consecutive edge-fn timeouts since 12:35Z (LOW; frozen-book #58, FMV/offers fresh, last good listings write 09:35Z)](2026-10-26T1806Z-daytime-monitor-candy-listings-indexer-timeout-2-consecutive.md)

## 2026-10-25 — 1 filing

- [🟢 Daytime monitor (10-25 ~03:05Z, infra GREEN, 16/16 dashboards OK) — panini-1.4.0 first full recalc landed; HIGH dist backed by real sales (accuracy spot-check remains)](2026-10-25T0305Z-daytime-monitor-panini-1.4.0-first-full-recalc-landed-HIGH-dist-backed-by-real-sales.md)

## 2026-10-24 — 1 filing

- [🟢 Daytime monitor (10-24 ~18:05Z, infra GREEN, 11/11 dashboards OK) — post-ship WATCH: panini-1.4.0 (Panini HIGH/MED now priced from panini_recent_sales_fmv_v2(panini_sales)) shipped ~15:22Z (commit 5427f2c7, migration 20261024152200); the 18:05Z snapshot's Panini FMV computed_at (13:35Z) predates the deploy, so the current green trust arms are a pre-engine-change reading — night pass to verify HIGH/MED + accuracy after the first full recalc under 1.4.0](2026-10-24T1807Z-daytime-monitor-panini-1.4.0-postship-watch-fmv-recalc-not-yet-swept.md)

## 2026-10-23 — 1 filing

- [✅ DRAINED 2026-10-22 11:20 PM PT (Claude Code: `cd292b289` + `4b8bae0e7`; the band was the Dapper custodian, not a decode dead zone; the lane is caught up as of the 10-23 2:15 PM PT run) — 🟡 Daytime monitor (10-23 ~03:10Z, infra GREEN, 11/11 dashboards OK) — allday-buyer-backfill decode dead-zone: 100%-decode-fail band ~2026-05-19→06-13 re-walked each cursor wrap, flaps the pipeline red ~31%](2026-10-23T0310Z-daytime-monitor-allday-buyer-backfill-decode-dead-zone-may-jun-2026.md)

## 2026-10-22 — 3 filings

- [🟢 Daytime monitor (10-22 ~21:15Z, infra GREEN) — `topshot_missing_fill_offers_walk` cursor jumped forward 9.4M blocks on 10-19: establish re-seed vs regression (since answered: weekly re-seed, arm fixed 10-22); holder-concentration scheduled-tick watch CLEARED (12:29Z ok=true)](2026-10-22T2115Z-daytime-monitor-green-missing-fill-offers-cursor-reseed-and-holder-concentration-watch-cleared.md)

- [🟢 Daytime monitor (10-22 ~03:13Z, infra GREEN, 11/11 dashboards OK) — `/api/public/pinnacle-image/[renderId]` MODULE_NOT_FOUND RECURRED 10-21 23:43Z on a new renderId (LEV1-SLBT-FORE-S6) and a new deploy, refuting the 10-19 "cold-start artifact / no recurrence" read; intermittent packaging break on a user-facing image route, not self-resolving — night pass to curl-confirm + fix, supersede 10-19 benign disposition](2026-10-22T0313Z-daytime-monitor-pinnacle-image-notfound-RECURRED-refutes-coldstart.md)

- [🟢 Daytime monitor (10-22 ~00:15Z, infra GREEN) — `rpc-insights-health` dashboard captions squeeze-check as `get_wallet_squeeze` (live fn is `get_wallet_squeeze_exposure`; caption only, fixed in repo mirror 10-23); watch: first scheduled panini-holder-concentration tick under the 300s + single-pass MV fix (cleared by the 21:15Z filing)](2026-10-22T0015Z-daytime-monitor-insights-health-label-drift-and-holder-concentration-postfix-watch.md)

## 2026-10-21 — 3 filings

- [🟢 Daytime monitor (10-21 ~00:15Z, infra GREEN) — refresh-conflated-editions hits its 120s Vercel wall on the daily 15:17Z tick, writes no terminal pipeline_runs row → detect_stalled_pipelines fires (silent 1969m), but both guard tables stay fresh (thin 8.8h + pg_cron 08:30 backstop OK; conflated 3.6h via 23 */6 remap). LOW: instrumentation gap, not stale data](2026-10-21T0015Z-daytime-monitor-refresh-conflated-editions-120s-wall-no-terminal-row.md)
- [**✅ DRAINED 10-20 / 10-22 (all 4 items settled in the filing itself; INDEX marker added 11-22) — 🔵 Daytime monitor (10-20 ~8:15 PM PT) — GREEN sweep, 4 candidates: (medium) refresh-conflated-editions missing its terminal log row on the 10-20 tick, data still fresh via the job-63 backstop; (medium) topshot_missing_fill_offers_walk cursor moved +9.4M blocks 10-19 (focus re-open trigger); (low) task 1b artifact sources + #114 map absent from the repo; (low) metrics baseline 3d stale, nba FMV HIGH+MED -1514**](2026-10-21T0315Z-daytime-monitor-conflated-editions-logrow-and-offers-walk-cursor-and-1b-source-gap.md)
- [**✅ CLOSED 10-21 ~8:45 AM PT (Claude Code cloud; ledger "fmv_stale_touch_hours is satisfiable at an empty cohort"): Step 6 was healthy — since 1.8.2 a re-stamp lands on LOW, so it drained its cohort 10-18 and the cohort is now 0 TS / 0 All Day; the arm could not clear at zero. Route reports `stale_touch_candidates`, arm re-shaped (`20261021154134`)** — 🔴 Daytime monitor (10-21 ~15:15Z / ~08:15 AM PT) — HIGH: fmv-recalc Step 6 (`force_stale` liveness touch) has touched nothing for ~41.7h / 260 consecutive runs; trust arm `fmv_stale_touch_hours` BREACH (41.7 vs 36). Route ok=true throughout — silent cohort-selection regression, not a crash; ~692 HIGH/MED no-recent-sale editions (579 TS + 113 AllDay) ageing. Suspect: Step 6/6b/7 gate+re-stamp churn 10-17→10-18. Night pass to bisect ~10-19 21:30Z onset](2026-10-21T1515Z-daytime-monitor-fmv-recalc-step6-force-stale-touch-flatlined-41h.md)

## 2026-10-20 — 3 filings

- [🟢 Daytime monitor (10-20 ~06:19Z, GREEN infra) — 2 low-risk housekeeping candidates: leftover `scratch_20261019_counter_checks_before` was the root cause of the 04:42–05:34Z smoke `rls_off` failures (now RLS-masked, drop it); `pg_net_http_404` arm 9 un-attributable 404s/2h with a Next.js `__next_error__` body (attribute to a cron hitting a 10-19-changed route)](2026-10-20T0619Z-scratch-counter-table-smoke-and-pgnet-404-attribution.md)
- [🟢 Daytime monitor (10-20 ~15:09Z, GREEN infra sweep) — WATCH candidate: confirm the new hourly All Day V1 reverify lane `rpc-allday-v1-listing-reverify` (pg_cron 762, shipped 14:46Z after the overnight handoff) succeeds on its first ticks; registered+active, no run yet at 15:08Z (first due 15:24Z)](2026-10-20T1509Z-daytime-monitor-verify-allday-v1-reverify-lane-first-ticks.md)

- [🟢 Daytime monitor (10-20 ~21:10Z, GREEN infra) — candidate: `topshot_missing_fill_offers_walk` cursor jumped +9.4M blocks forward (158.9M→168.3M) on 10-19 18:12Z, rewind_count 2; driving pipeline `backfill-offer-fill-sales` is green (not wedged, freshness fine) but the forward jump may leave a silent un-rewalked coverage gap — night pass to establish deliberate re-seed vs cursor-write regression (class ee90eb54c) before dismissing](2026-10-20T2110Z-daytime-monitor-topshot-missing-fill-offers-cursor-rewound-9.4m-blocks.md)

## 2026-10-19 — 2 filings

- [**✅ CLOSED 10-19 ~2:50 PM PT (Claude Code cloud; ledger "missing-fill walk suppression names the weekly schedule"): (1) the weekly walk's deliberate re-seed, suppression text rewritten; (2) pinnacle-image serves 302 / 200 PNG; (3) the 42501 was already fixed by the morning `readiness_panini_*` migrations** — 🟢 Daytime monitor (10-19 ~21:12Z, GREEN infra) — 3 low-risk candidates: `missing_fill_offers` cursor re-seeded forward 9.4M blocks + walk active despite 10-10 done=true; pinnacle-image MODULE_NOT_FOUND on the serving deploy (verify 200); /api/ready 42501 on panini_sales post-#64 (verify grant)](2026-10-19T2112Z-daytime-monitor-missing-fill-reseed-pinnacle-image-notfound-api-ready-panini-grant.md)

- [**✅ RECORDED 10-19 (already in pack-ev.md from ~7:05 AM PT; timeout watch read added ~12:15 PM PT, re-read after ≥ 3 days) — 🟢 Daytime monitor (10-19 ~11:11 AM PT, GREEN) — pack_rips post-vacuum READ handed off by the 10-19 night pass: allvisible 72.1%→100.0%, `v_allday_pack_lifecycle` dist 6924 285ms/901→36ms/147 heap fetches; record in pack-ev.md**](2026-10-19T1811Z-daytime-monitor-pack-rips-post-vacuum-measurement-for-pack-ev.md)

## 2026-10-18 — 3 filings

- [**✅ CLOSED 10-18 ~1:10 PM PT: the tile read itself is 7 ms, but it walked the whole PK index (1,145 buffers for 7 rows); a partial index (`20261018200418`) makes it a 2-buffer index-only scan. 1 of the 2 hits landed a minute after the 2-hourly refresh (jobid 688, 7–8 s)** — 🔵 Daytime monitor (10-18 ~08:08 AM PT) — LOW: the `nfl_all_day` collection market-cap tile times out at 8 s on `/[collection]/overview`, a post-pdx1 straggler (first 10-16, ~1/day, visibility-only)](2026-10-18T1508Z-daytime-monitor-nfl-collection-market-cap-tile-8s-read-timeout-post-pdx1.md)
- [**#192 ✅ verified 10-17 ~11:20 PM PT (480/480 buyers); demand re-read (10-22) and #193 (10-31) still date-gated** — 🟡 Claude Code (10-17 ~7:45 PM PT) — three DATE-GATED checks for the night pass: verify #192 (10-18), demand re-read (on/after 10-22), #193 Pinnacle HIGH re-measure (on/after 10-31)](2026-10-18T0233Z-claude-code-dated-checks-192-verify-demand-reread-193-pinnacle.md)
- [**✅ CLOSED 10-17 (fix: the `step1b_refetch_empty` skip advances the cursor on an error-free empty page; ledger 10-17) — re-verified 10-18 ~1:05 PM PT: every catalogue-sweep run since noon PT wrote 499–1,493 rows** — 🔴 Daytime monitor (10-17 ~5:12 PM PT) — HIGH: fmv-recalc catalogue sweep WEDGED in step1b_refetch_empty, holds its cursor on a genuinely-empty page since ~12:48 PM PT; catalogue silently not repriced](2026-10-18T0012Z-daytime-monitor-fmv-recalc-sweep-wedged-step1b-holds-cursor-on-empty-page.md)

## 2026-10-15 — 4 filings

- [**🟢 Daytime health monitor — GREEN (10-15 ~06:00Z sweep); no candidate work**](2026-10-15T0009Z.md)
- [**✅ CLOSED 10-15 ~1:05 PM PT — Daytime monitor (08:05 AM PT): one `/api/sniper-feed` badge_editions page-8 "Project not specified"**](2026-10-15T1509Z-daytime-monitor-sniper-feed-badge-editions-page8-project-not-specified.md)
- [**✅ ALL THREE CLOSED 10-15 ~1:05 PM PT — Daytime monitor (11:10 AM PT, GREEN): zz_probe drop · golazos_sales_v1_backfill suppression · misattrib-drain bound**](2026-10-15T1810Z-daytime-monitor-green-zz-probe-cleanup-golazos-backfill-suppress-misattrib-bound.md)
- [**✅ RESOLVED 10-15 ~1:00 PM PT (both probes dropped in `20261015195905`; the R126 trigger half applied as `20261015145336`) Daytime monitor — leftover `zz_probe_20261014` scratch function with no pinned `search_path` (advisor WARN)**](2026-10-15T0604Z-daytime-monitor-leftover-zz_probe-scratch-functions-search-path-drift.md)

## 2026-10-14 — 1 filing

- [**✅ DISPOSITIONED 10-15 (measured: the tile reads are 5.8 ms / 48 ms; the timeouts coincide with other routes' timeouts and a Supabase 502 — estate stalls, no change) 🟡 Daytime monitor candidate — Panini edition market-cap tile hits its 8 s read timeout**](2026-10-14T1505Z-daytime-monitor-panini-edition-market-cap-tile-8s-read-timeout.md)

## 2026-10-13 — 1 filing

- [**✅ DISPOSITIONED 10-14 (`20261014235448`: `candy_sales_stale_hours` made indexer-health-aware; the stall was a genuine market freeze, not a bug) 🟡 Daytime monitor — `candy_sales_stale_hours` breach, thin market**](2026-10-13T1509Z-daytime-monitor-candy_sales_stale-breach-thin-market.md)

## 2026-10-12 — 1 filing

- [**✅ FIXED 10-11 ~9:30 PM PT (code): the activities leg retries once, then DEGRADES instead of aborting** 🟡 **Daytime monitor — `candy-offers-indexer` 2/7 timeouts over 3 days (28.6 %), undispositioned; both hung in `discovery_activities`**](2026-10-12T0010Z-daytime-monitor-candy-offers-indexer-timeout-28pct-undispositioned.md)

## 2026-10-11 — 4 filings

- [**✅ RESOLVED 10-11 ~9:20 AM PT (`20261011161254`, history v23: status before enrichment)** 🟡 **Daytime monitor candidate — `get_wallet_pack_summary` occasionally exceeds the 8 s RPC read budget (3 requests in 22 min, 10-10 ~8:46–9:08 PM PT); pre-existing, not a regression of the 10-10 ships**](2026-10-11T0609Z-daytime-monitor-get-wallet-pack-summary-8s-rpc-read-timeout.md)
- [**✅ DISPOSITIONED 10-11 (night pass): known #58, Trevor-only env var** 🟡 **Daytime monitor candidate — the three candy-opensea indexers fail every tick on `OPENSEA_API_KEY not set`**](2026-10-11T0307Z-daytime-monitor-candy-opensea-indexers-missing-OPENSEA_API_KEY.md)
- [**✅ FIXED 10-10 ~9:39 PM PT (`20261011043919`, window 30 → 365 d)** 🟡 **The chain hydrator's backlog leg re-probes moved Moments at a 0.2 % yield — 20,896 scripts a week for 51 rows**](2026-10-11T0200Z-chain-hydrator-backlog-leg-reprobes-moved-moments-at-0-2pct-yield.md)
- [**✅ DISPOSITIONED 10-11 (night pass + 0307Z tick): 401 aged out; misattrib draining (#101); allday-reconcile chronic** 🟡 **Daytime monitor candidates — unattributed pg_net 401, misattrib-drain suppression drift, allday-storefront-reconcile failure_rate**](2026-10-11T0008Z-daytime-monitor-unattributed-pg_net-401-and-misattrib-drain-drift.md)

## 2026-10-09 — 1 filing

- [**✅ FIXED 10-09 ~8:25 AM PT (`20261009150720`)** 🟡 **`panini-bridge-sync` fail-closed every tick on a 1-player slug collision**](2026-10-09T1504Z-panini-bridge-sync-fail-closed-on-a-1-player-slug-collision.md)

## 2026-10-08 — 1 filing

- [**✅ FIXED 10-09 ~10:00 AM PT (`20261009162222` / `…165544`)** 🔴 **`rpc-chain-arrival-pack-pulls` re-wedged, 16 h apply stall, 4th consecutive night: ship the durable bound, not a 5th hand-drain**](2026-10-08T0010Z-chain-arrival-pack-pulls-re-wedged-16h-stale-4th-consecutive-night-prioritize-durable-bound.md)

## 2026-10-06 — 2 filings

- [**✅ RESOLVED: (1) burst self-resolved 10-06 15:45Z, re-queue guard `20261009162520`; (2) FIXED 10-09** 🔴 **`topshot-sellback-walk` nft_id-null regression (322 ticks failed) + `rpc-chain-arrival-pack-pulls` re-wedged within ~3 h of the hand-drain**](2026-10-06T1510Z-sellback-nft_id-null-regression-and-chain-arrival-redrain-held-3-ticks.md)
- [**✅ FIXED 10-09 ~10:00 AM PT (`20261009162222` / `…165544` / `…162520`); hourly ticks 0.07–0.10 s since** 🔴 **`rpc-chain-arrival-pack-pulls` wedged: 13 consecutive 120 s statement timeouts, backlog growing, no self-heal (the 10-04 recurrence)**](2026-10-06T0013Z-chain-arrival-pack-pulls-wedged-13-consecutive-120s-timeouts-the-10-04-recurrence.md)

## 2026-10-05 — 5 filings

- [**✅ FIXED 10-09 ~10:00 AM PT (`20261009162222` / `…165544`)** 🔴 **`rpc-chain-arrival-pack-pulls` WEDGED: 10 consecutive hourly timeouts, 0 deliveries applied in 11 h**](2026-10-05T2106Z-chain-arrival-pack-pulls-wedged-10-consecutive-timeouts-unbounded-run-recurrence.md)
- [**✅ RESOLVED 10-09 ~10:00 AM PT: jobid 15 deactivated (`cron.alter_job(active := false)`)** 🟡 **`topshot-pack-supply-backfill` 100 % failed (HTTP 530) on every run since 10-03**](2026-10-05T1809Z-daytime-monitor-topshot-pack-supply-backfill-100pct-http-530-3-days.md)
- [**✅ FIXED 10-09 ~10:00 AM PT (`20261009162222` / `…165544`)** 🟠 **`rpc-chain-arrival-pack-pulls` stuck since the 11:13Z seed: 4 hourly statement timeouts, the apply lane does not self-recover**](2026-10-05T1512Z-pack-pulls-apply-self-stuck-after-11-13z-seed.md)
- [**✅ items 1+2 RUN 10-10 ~11:35 AM PT (7 dupes archived + deleted; 19 tables + 11 fns dropped)** 🟠 **Handoff from Claude Code (Trevor: "Hand that off to cowork"): run `dedupe_tx_lane_20261004.sql` then `drop_scratch_20261004.sql` (both guarded, AUTHORIZED by Trevor) + investigate #173 (conflated `topshot_moment_subeditions` bases, do not ship)**](2026-10-05T0410Z-flowty-thread-handoff-dedupe-drop-and-173.md)
- [🟢 **Daytime monitor repeat: chain-arrivals seed timeout (already fixed, `20261004160000`, catch-up drained) + Candy bid book empty (benign, as in 2112Z)**](2026-10-05T031053Z.md)

## 2026-10-04 — 6 filings

- [🟢 **Candy MLB bid book empty, 2 trust arms at 999 by design — BENIGN: the 11 offers still escrowed upstream all expired Jul–Sep, the one live bid was withdrawn/filled; plus the 429 HIGH (scratch Flowty promotion + the chain-arrival catch-up, both owned and decaying) and the seed timeout (already fixed)**](2026-10-04T2112Z-candy-offers-book-zeroed-and-429-scratch-decay.md)

- [🔴 **65,477 Top Shot pack rips carry an INFERRED `dist_id` their purchase record contradicts; sink dists (8552 reward pack: 27.5 k of 49.5 k rips are other packs'). Pack pages miscount opens / EV. Verification queued (64,930 packs); bulk purchase-copy refuted. ✅ Re-keyed BY CHAIN from 11:00 AM PT (6,262 + lane pg_cron 704, backed up)**](2026-10-04T1627Z-pack-rips-dist-inferred-wrong-65k-rips-sink-dists.md)

- [🟢 **`rpc-chain-arrivals-seed` hit its 300 s timeout (4:13 AM PT) — FIXED: structural, not load. The purchase check probed 8 `sales` partitions per held moment (2.58 M buffers); now it reads the wallets' purchases once and skips already-probed moments (`20261004160000`, equivalent on prod: 56 = 56, 16,072 = 16,072). Catch-up 45.7 s seeded 16,143.**](2026-10-04T1505Z-chain-arrivals-seed-timeout-and-flow-pg_net-400.md)

- [🟢 **Panini insight boards timing out, snapshot stale 165 min — RESOLVED: three covering indexes (`20261004123243` / `124114` / `124411`); deal board 23.8 s → 0.99 s. Not the transient the overnight pass called it.**](2026-10-04T0609Z-panini-insight-boards-timeout-and-stale-since-0407z.md)

- [🟢 **`pg_net_http_403` Firestore-shaped `PERMISSION_DENIED` cluster — ATTRIBUTED: the finished Flowty Firestore-index backfill (scratch pg_cron 689/690), not `sync-nba-projections`; 0 such 403s in the retained window**](2026-10-04T0010Z-daytime-monitor-pg_net-403-firestore-permission-denied-cluster.md)

- [**✅ FIXED 10-04 ~6:40 AM PT — ⛔ the 75k was CI's vitest (ASN Microsoft), not our lambdas; tests now read fonts from disk; the lambda disk read (6:15) covers the ~1k/week that was ours** 🟡 **OG cards fetch their own brand fonts over HTTP ~75,000 times a week (5.5 GB of self-traffic, `node` user agent) — bundle them; NOT shipped because the loader fails SOFT and only a production render can prove the fix**](2026-10-04T0350Z-og-cards-fetch-their-own-fonts-over-http-75k-times-a-week.md)

## 2026-10-03 — 2 filings

- [🟢 **`atlas-editions-upstream-403` HIGH: 1 of 282 sets past 6 h — ROOT CAUSE FIXED by `20261003151308`: a set failing on page 0 waited a full ~82-min cycle per retry (chance at a steady ~17 % 403 rate), now retries after 5 min; same calls per tick**](2026-10-03T1504Z-daytime-monitor-atlas-editions-one-set-stalled-6h.md)

- [🟢 **pack-mint-probes 20 s probe timeouts near-total on 10-02 — RESOLVED by #166 (`20261003045659`): node faults retry 12 times; failed holds at 6, none at ≥12 attempts (re-checked 10-03 ~7:45 AM PT)**](2026-10-03T0006Z-daytime-monitor-pack-mint-probes-near-total-20s-timeout.md)

## 2026-10-02 — 1 filing

- [🟢 **pg_cron `rpc-wallet-reconstructed-rips` killed at 120 s — RESOLVED: fixed by `20261002144052` (600 s budget on the cron command, per-wallet sub-transactions, kill recorded) about 15 min before this tick; catch-up ok, 33/33 wallets, 118.7 s**](2026-10-02T1510Z-wallet-reconstructed-rips-daily-timeout.md)

## 2026-10-01 — 2 filings

- [🟢 **`topshot_impossible_parallel_serials` arm read 999 at the month boundary — RESOLVED: the rotation had already filled 2026-09; the leg now counts the just-closed month live, so the boundary no longer reads 999**](2026-10-01T0314Z-daytime-monitor-impossible-parallel-arm-blind-at-month-boundary.md)

- [🟢 **Special-serial badges should use each platform's NATIVE colour — RESOLVED: sampled live (Top Shot #2752ED, All Day #7A4DE1 ring), shipped to trophy slab, PDF and OG cards**](2026-10-01T0141Z-special-serial-badges-native-platform-color.md)

## 2026-09-30 — 3 filings

- [🟢 **panini-collector-walk `usernotfound` on 3 targets — RESOLVED: Philthy503, Juiceshack, Cazsreyem dropped from the walk list (their Top Shot names are not Panini names)**](2026-09-30T1509Z-daytime-monitor-panini-collector-walk-usernotfound.md)
- [🟢 **edition_integrity_flags BREACH (308 vs 250) — 301 new Panini editions with tier NULL — RESOLVED: data backfilled by Cowork, `Common` added to the ingest tier map**](2026-09-30T0303Z-daytime-monitor-edition-integrity-breach-panini-fresh-editions-missing-tier.md)
- [🟢 **TS active-listings feeder dark ~25.8 h + atlas-editions 403 watch — RESOLVED: the Windows task's headless Chromium was challenged by Cloudflare; the ingest now defaults to installed Chrome**](2026-09-30T0013Z-daytime-monitor.md)

## 2026-09-29 — 1 filing

- [🟡 **pg_net 429 surge (2,285 / 2 h) — ATTRIBUTED: Flow REST access-node limiter (envoy), 88 % in the first 5 s of a minute, from today's every-minute Flow lanes**](2026-09-29T2110Z-daytime-monitor-off-window-pg_net-429-volume-symptom.md)

## 2026-09-28 — 1 filing

- [🟢 **topshot_offer_fill_backfill cursor_stalled 7.5 h — RESOLVED on its own: GHA delivered no scheduled run for ~8 h; cursor now ahead of live**](2026-09-28T1511Z-daytime-monitor-offer-fill-backfill-cursor-stall.md)

## 2026-09-26 — 2 filings

- [🟢 **Daytime monitor GREEN; two LOW candidates — player-stats-sync duplicate-key upsert, storefront-reconcile lanes co-firing into QuickNode 429s — both RESOLVED upstream**](2026-09-26T0308Z-daytime-monitor-two-low-candidates.md)

- [🟡 **sync-nba-projections 100% failure (8/8 in 24h) — dispositioned: it is known-issue #8, shelved 09-23, alert muted to 10-13; upstreams 403, not offseason**](2026-09-26T0006Z-daytime-monitor-sync-nba-projections-100pct-failure-24h.md)

## 2026-09-24 — 1 filing

- [🟢 **Daytime health harvest: platform healthy; one LOW candidate — `topshot_pack_reality_top_ev` returns 0 rows**](2026-09-24T2110Z.md)

## 2026-09-23 — 2 filings

- [🔴 **A fourth ASK_ONLY writer, `fmv_from_cached_listings`, republishes Flowty's valuation as RPC FMV over $1,000,000 troll floors, and re-created a retired All Day price within 4 h**](2026-09-23T0510Z-a-fourth-ask-only-writer-republishes-third-party-valuations-over-troll-floors.md)

- [🔴 **Deal alerts are NOT blocked by ask freshness — both subscriptions refuted, and the proposed Atlas widening buys nothing**](2026-09-23T0155Z-deal-alerts-are-not-blocked-by-ask-freshness-both-subscriptions-refuted.md)

## 2026-09-22 — 1 filing

- [🔴 **All Day FMV is capped by month-old floor listings the market keeps clearing ABOVE — 55 % of HIGH editions sit below every one of their last 7 sales**](2026-09-22T2045Z-allday-fmv-is-capped-by-month-old-floor-listings-the-market-clears-above.md)

## 2026-09-21 — 3 filings

- [🔴 **Daytime monitor — `compute-allday-pack-ev` fails EVERY run on `pool prune 5349: Bad Request` (post-R123)**](2026-09-21T1813Z-daytime-monitor-compute-allday-pack-ev-pool-prune-5349-400.md)

- [⚠ **Daytime monitor — `snapshot-institutional-wallets` silent ~31h, known chronic class, hand-dispatch not re-investigate**](2026-09-21T0318Z-daytime-monitor-institutional-wallet-snapshot-silent-31h.md)

- [📏 **Daytime monitor — Top Shot HIGH+MED fell ~974 vs the 08:10Z baseline, filed as a RE-MEASURE and not an alarm**](2026-09-21T0011Z-daytime-monitor-topshot-high-med-confidence-fell-974-vs-the-0810z-baseline.md)

## 2026-09-20 — 5 filings

- [⏳ **Verify the thin-FMV self-heal, and the cadence arm that is dormant until 09-21 17:30 PT**](2026-09-20T1930Z-verify-the-thin-fmv-self-heal-and-the-refresh-conflated-editions-cadence-arm.md)

- [✅ **Daytime monitor mid-day tick — both items CLOSED the same day: the reindex HIGH was already fixed 11 min after the failure it cites, and the #126 escalation cleared on its own**](2026-09-20T1812Z.md)

- [⛔ **The "22 MB/s floor" is not folklore — it is Supabase Small's PUBLISHED baseline, and the instance is sitting on it at 93%**](2026-09-20T1730Z-the-22-mb-s-floor-is-supabase-smalls-published-baseline-and-we-are-sitting-on-it.md)

- [⚠ **The Panini "what this total is made of" disclosure annotates a DIFFERENT population than the KPI above it — and errs in the flattering direction**](2026-09-20T1709Z-the-panini-ask-only-disclosure-annotates-a-different-population-than-the-kpi-above-it.md)

- [**Two watched pipelines read `invoked_but_never_logged` — but the reading was taken DURING a live saturation spell, so it is filed as a symptom, not a stall**](2026-09-20T1513Z-two-hourly-pipelines-invoked-but-never-logged-under-a-live-morning-saturation-spell.md)

## 2026-09-19 — 22 filings

- [🚨 **The `edition_fmv_current` full reconcile is AFFORDABLE and UNREACHABLE — the fix its own column comment names is dead code in production, and so is the prune**](2026-09-19T2350Z-the-edition-fmv-current-full-reconcile-is-affordable-but-unreachable.md)

- [🚨 **The confidence precompute's collection list is HARDCODED and has drifted BOTH ways — Candy (the best-covered collection in the estate) is invisible, and Pinnacle publishes a `{}` that has never meant anything else**](2026-09-19T2346Z-the-confidence-precomputes-collection-list-is-hardcoded-and-has-drifted-from-reality.md)

- [🚨 **jobid 506 is STRUCTURALLY over budget — one arm is 85% of the 120 s, and the obvious fix is forbidden in writing** *(⚠ CORRECTED: a headline-KPI claim in the first push is RETRACTED)*](2026-09-19T2324Z-jobid-506-is-structurally-over-budget-and-the-stale-cache-understates-the-headline-kpi.md)

- [⚠ **The trust/confidence precompute writer (jobid 506) misses about half its daytime ticks on the 120 s ceiling — the trust surface serves ~20 h-old confidence by afternoon**](2026-09-19T2106Z.md)

- [🚨 **The Underpriced board's "only feeder" is silent — and the box-dark explanation is REFUTED, while a datacenter-independent mirror is already running**](2026-09-19T2012Z-the-underpriced-board-s-only-feeder-is-silent-and-a-live-alternative-is-already-running.md)
- [🚨 **`Cadence Collapse` is CRITICAL on 9 lanes and SEVEN OF THE NINE ARE FALSE POSITIVES — they are the entire reason it pages at CRITICAL**](2026-09-19T1800Z-cadence-collapse-is-critical-on-9-lanes-and-7-of-them-are-false-positives.md)
- [⚠ **The sentinel's wall budget starves the END of its arm list — `Ops Probe Cost` was refused on 22 of 22 findings in 48 h**](2026-09-19T1755Z-the-sentinels-wall-budget-starves-the-end-of-its-arm-list-systematically.md)
- [⚠ **`daily-portfolio-snapshot` has missed two days of portfolio history — and THREE obvious hypotheses are already dead**](2026-09-19T1745Z-daily-portfolio-snapshot-has-missed-two-days-and-three-hypotheses-are-already-dead.md)
- [🎯 **The pack-sales "head-check" the 2026-08-26 entry called UNAVAILABLE is implementable after all — the walker's whole position is state in OUR database**](2026-09-19T1730Z-the-head-check-the-08-26-entry-called-impossible-is-implementable-from-the-cursor-table.md)
- [🚨 **Five edge-function cron lanes write NO `pipeline_runs` row and are structurally invisible to the sentinel — two of them were DEAD for 6 and 7 days**](2026-09-19T1715Z-five-edge-function-cron-lanes-write-no-pipeline-runs-row-and-are-structurally-invisible-to-the-sentinel.md)
- [⚠ **All 224 Golazos `pack_distributions` rows carry DEFAULTED zeros, not measurements — frozen since 2026-07-10**](2026-09-19T1720Z-all-224-golazos-pack-distributions-carry-defaulted-zeros-not-measurements.md)
- [⚙️ **`cron.max_running_jobs` is 32 on a box with `max_worker_processes` = 6 — a 5× overcommit, and it is the `job startup timeout` class**](2026-09-19T1245Z-pg_cron-is-configured-to-run-32-concurrent-jobs-on-a-box-with-6-worker-slots.md)

- [⚠ **The unhandled-third-state guard sees ONE syntactic shape — the class was alive in five places it cannot see, and a weekly pricing lane has no telemetry at all**](2026-09-19T1237Z-the-third-state-guard-sees-one-syntactic-shape-and-the-class-was-alive-in-five-places.md)

- [🟡 **Daytime monitor 06:11Z — the answer to the 02:45Z re-read: NOT recovered. The saturation has persisted ~4.5 h, and a HEALTHY verdict tonight would be the “sweep ok ≠ lanes ok” shape**](2026-09-19T0611Z-daytime-monitor.md)

- [🔴 **`rpc-ts-listings-atlas-sync` is at 100% failure, has written nothing for 35 minutes, and its own `*/2` cadence is now the ratchet holding it there**](2026-09-19T0531Z-ts-listings-atlas-sync-is-at-100-percent-failure-and-its-own-cadence-is-the-ratchet.md)

- [⚠ **`cross_collection_cohort_mat` is 53.5 h stale — and the index-bloat cause the filing proposes is refuted by arithmetic before a probe is needed**](2026-09-19T0310Z-daytime-monitor.md)

- [🔴 **IO saturation since ~6:30 PM PT persists after the R101 revert AND the 940 MB `wallet_moments_cache` autovacuum — the Atlas listing lane times out on 9 of 12 ticks, no single hog in `pipeline_runs`**](2026-09-19T0245Z-io-saturation-persists-after-the-r101-revert-and-the-wmc-vacuum.md)
- [🚨 **`edition_fmv_current` serves a value its own source row contradicts — 162 of 14,016 Top Shot editions, skewed HIGH, and it is what eleven public boards read**](2026-09-19T0230Z-edition_fmv_current-serves-a-value-its-own-source-row-contradicts.md)

- [⛔ **R103 re-derived — the ask-corroboration bound reads a stamp that stopped meaning "confirmed", and 4,561 of 4,561 past-bound Top Shot asks are confirmed LIVE by an independent mirror**](2026-09-19T0130Z-the-ask-corroboration-bound-reads-a-stamp-that-stopped-meaning-confirmed.md)
- [🚨 **The Atlas listing-lane fix has a CONTAMINATED baseline — the #122 outage made the lane look healthy for six hours by stopping it working, and the improvement STARTED 2 h BEFORE the migration**](2026-09-19T0130Z-the-atlas-listing-lane-fix-has-a-contaminated-baseline-and-its-falsifier-should-say-so.md)

- [⚠ **The anon write-grant SET diffed to MEMBERSHIP (run 5 §10's owed item) — 5 objects, 4 deliberate and bounded, and the 5th is dead residue neutralised BY ACCIDENT**](2026-09-19T0117Z-the-anon-write-grant-set-diffed-to-membership-and-the-fifth-object-is-dead-residue.md)

- [⛔ **Daytime monitor 00:11Z — its own HIGH-ish item is REFUTED by the live cron schedule; what survives is a missing arm on the go-live headline's freshness**](2026-09-19T0011Z.md)

## 2026-09-18 — 5 filings

- [🟡 **Daytime monitor 21:06Z — the estate is QUIET two hours after the outage, and the one trust-health breach is outage-shadow that must be RE-MEASURED, not fixed**](2026-09-18T2106Z.md)
- [⛔ **The `/api/wallet-search` windowing fix CANNOT WORK — and no on-chain accessor can read a sharded Top Shot collection at all**](2026-09-18T1700Z-the-wallet-search-windowing-fix-cannot-work-no-on-chain-accessor-can-read-a-sharded-collection.md)
- [🕐 **Daytime monitor 15:13Z — the DB event has NOT self-cleared ~52+ min on, and every DB-gated sweep this tick is UNKNOWN rather than healthy**](2026-09-18T15-13-35Z.md)
- [🚨 **Daytime monitor — DB reads unavailable across MCP *and* production at once, and the `pg_stat_activity` positive control is exactly what cannot be taken**](2026-09-18T1445Z.md)
- [🔴 **Production is 503ing on public boards, the DB is unreachable from tooling — and the FIRST job is a baseline, not a fix**](2026-09-18T1445Z-production-is-503ing-and-the-db-is-unreachable-take-the-7-day-baseline-first.md)

---

## 2026-09-14 — 15 filings

- [🟡 **Daytime monitor 21:08Z — `topshot_pack_reality_top_ev` renders 0 rows while its sources are fresh and populated; VERIFY genuine-empty vs filter regression**](2026-09-14T2108Z-daytime-monitor.md)
- [🟡 **Daytime monitor — 2026-09-14T18:16Z: `rpc_ops_snapshot()` still cancels under only MILD elevated IO, and the Top Shot sniper feed ran ~19 min stale** — both filed as quiet-window RE-MEASURES, not conclusions (bears on #121 / #42)](2026-09-14T1816Z-snapshot-still-cancels-under-mild-load-and-sniper-feed-staleness.md)

- [⏱ **A lane has ticked 4,023 times since it last found a row, reports `ok` every time, and its cursor has not moved in 39 days**](2026-09-14T1820Z-a-lane-has-ticked-4023-times-since-it-last-found-a-row.md)

- [⚠ **`/api/wallet-search` cannot read a mega-wallet at all, and tells the user to "Please try again"** — a deterministic failure wearing transient copy; the windowed fetch already exists in this repo](2026-09-14T1749Z-wallet-search-cannot-read-a-mega-wallet-and-tells-the-user-to-try-again.md)

- [📋 **The `snapshot-institutional-wallets` deploy is one command, and the drift hazard is NARROWER than "unknown"**](2026-09-14T1735Z-the-snapshot-deploy-is-one-command-and-the-drift-hazard-is-narrower-than-unknown.md)
- [🚨 **#114's live half is FIFTEEN dashboards, not five — and eleven of them "handle errors" against a shape the server never sends**](2026-09-14T1533Z-114s-live-half-is-fifteen-dashboards-not-five-and-eleven-guard-the-wrong-error.md)

- [🚨 **I executed the suppressions' own predicates instead of reading them — 2 of 3 hold, 1 fails, and one lane now has no scheduler, no alarm and no suppression at once**](2026-09-14T1514Z-i-executed-the-suppression-predicates-and-one-lane-has-no-scheduler-no-alarm-and-no-suppression.md)
- [⭐⭐ **The first RATE-based IO ranking this platform has had — the Atlas lanes are 37 % of it and `fmv-recalc` is 4.8 %, not the top reader**](2026-09-14T1440Z-the-first-rate-based-io-ranking-and-fmv-recalc-is-not-the-top-reader.md)

- [🟡 **#75's exit condition needs an owner that HAS Supabase MCP — the `connectors` parameter that would have fixed it is ORG-GATED**](2026-09-14T1430Z-75-re-measure-the-pg-net-store-on-or-after-09-20-the-connectors-param-is-org-gated.md)
- [🚨 **GitHub caps scheduled delivery at ~0.3 ticks/hour PER WORKFLOW — a tighter cron buys nothing, and the site-down alarm runs at 7.8 % of its schedule**](2026-09-14T1400Z-github-caps-scheduled-delivery-at-about-one-tick-every-three-hours-per-workflow.md)

- [⛔ **The "platform's largest addressable IO waste" is ALREADY OVER — the rate is ZERO and the R21 priority it set dissolves**](2026-09-14T1330Z-the-platforms-largest-io-waste-is-already-over-and-the-priority-it-set-dissolves.md)

- [✅ **Daytime monitor — 2026-09-14T06:12Z (11:12 PM PT, 09-13): #82's detector is a LIVE producer, 5 → 29 → 35** — LEAD NOW CLOSED, #82 repaired same morning and the metric reads 0; the open successor is #116](2026-09-14T0612Z-daytime-monitor-82-detector-climbing-confirms-live-producer.md)

- [✅ **The edition-verify lane cannot conclude on 74 % of its calls, and the fix is in the REQUEST, not the rate** — instrument SHIPPED `20260914032500`, pagination fix NOT](2026-09-14T0327Z-the-edition-verify-lane-cannot-conclude-on-74-percent-of-its-calls.md)

- [⛔ **The Pinnacle Goofy concierge probe is PERMANENTLY RED on correct behaviour — and `RPC Smoke Concierge Daily` no longer fails**](2026-09-14T0135Z-the-goofy-concierge-probe-is-permanently-red-on-correct-behaviour.md)

- [🔴 **Daytime monitor — 2026-09-14T00:10Z (5:10 PM PT, 09-13): `rpc-ts-listings-atlas-sync` is `active = false` and the Top Shot sniper's data is frozen**](2026-09-14T0010Z-daytime-monitor.md)

## 2026-09-13 — 15 filings

- [🟡 **Daytime monitor — 2026-09-13T21:10Z (2:10 PM PT): a SECOND IO-saturation window, and this one has NO maintenance op behind it**](2026-09-13T2110Z-daytime-monitor.md)

- [✅ **The counterparty lane spins on a 42-row residue, and the obvious one-line fix is a regression** — FIXED `20260913190927`, watching](2026-09-13T1900Z-the-counterparty-lane-spins-on-a-42-row-residue-and-the-obvious-one-line-fix-is-wrong.md)

- [🟡 **SYMPTOM: autovacuum is now running on `net._http_response`'s toast mid-spell — and it lands on top of a VACUUM FULL already scheduled for tonight**](2026-09-13T1807Z-autovacuum-now-running-on-the-net-http-response-toast-mid-spell.md)

- [🟠 **The counterparty claim needs partial indexes that carry its source exclusions — owed, in a calm window**](2026-09-13T1800Z-sales-claimable-partial-indexes-owed-in-a-calm-window.md)

- [🟡 **The IPFS-served art is 2–8 MB of PNG going into tiles as small as 28px**](2026-09-13T1708Z-the-ipfs-served-art-is-2-to-8-mb-of-png-going-into-tiles-as-small-as-28px.md)

- [🟡 **The master alarm goes BLIND under the exact condition it exists to catch — 3 of 11 arms INCONCLUSIVE, rising 0→1→2→3 in seven hours — and the marker an observer would count is not applied uniformly**](2026-09-13T1707Z-the-master-alarm-goes-blind-under-the-exact-condition-it-exists-to-catch-and-its-blind-marker-is-inconsistent.md)
- [🟡 **The UFC "zero edge caching" leg is NOT our proxy's header — and two of its three gateways are dead for UFC**](2026-09-13T1512Z-the-ufc-zero-ttl-leg-is-not-our-proxys-header-and-two-of-its-three-gateways-are-dead-for-ufc.md)

- [🟡 **Daytime monitor — 2026-09-13T15:10Z (08:10 PT, first tick of day): cross-collection step2 missed a cycle and the overlap mat is ~39 h stale**](2026-09-13T1510Z.md)

- [🟡 **The wallet-backfill fan-out has NO back-pressure — 11 of 11 unrelated lanes are slower when it is ≥10 deep, none faster**](2026-09-13T1445Z-the-wallet-backfill-fan-out-has-no-back-pressure-and-here-is-what-it-costs-every-other-lane.md)
- [🟡 **`reconcile-saved-wallet-stats` reports `ok = false` for its HEALTHY path — 41 of 41 "failures" are one benign string — and the alarm case for fixing it is REFUTED**](2026-09-13T0900Z-reconcile-reports-ok-false-for-healthy-work-and-the-alarm-case-for-fixing-it-is-refuted.md)
- [✅ **The wallet-backfill BACKSTOP had quietly become a bigger consumer than the waves it backs up — its freshness guard was skipping ZERO — FIXED**](2026-09-13T0800Z-seeded-wallet-stats-runs-seventeen-deep-and-is-a-top-tier-consumer.md)
- [✅ **Daytime monitor — 2026-09-13T06:06Z (09-12 23:06 PT): the deploy tip was ERROR on a >256-char `ignoreCommand` — both HIGHs since RESOLVED**](2026-09-13T0606Z.md)

- [✅ **Daytime monitor — 2026-09-13T03:06Z (09-12 20:06 PT): no new candidates, and it CLOSES the 00:09Z precompute/board pair as spell collateral**](2026-09-13T0306Z-daytime-monitor.md)

- [🟡 **341 source files sit in NO coverage gate — and until today nothing watched the DENOMINATOR**](2026-09-13T0108Z-341-source-files-sit-in-no-coverage-gate-and-nothing-watched-the-denominator.md)

- [✅ **Daytime monitor — 2026-09-13T00:09Z (09-12 17:09 PT): the pack-ask and Golazos feeds stopped at the same second — both since RECOVERED**](2026-09-13T0009Z-daytime-monitor.md)

## 2026-09-12 — 13 filings

- [✅ **`pinnacle-metadata-backfill` went FULLY silent after 11:22Z — a tenth dropped lane, not covered by the nine-lanes filing or the GHA backstop — since RECOVERED**](2026-09-12T2116Z-pinnacle-metadata-backfill-went-fully-silent-after-1122z-a-tenth-disabled-lane.md)

- [🔴 **The `net._http_response` fix treats the 17 MB HEAP — the 10 GB TOAST has NEVER been autovacuumed and is still growing at the pre-fix rate**](2026-09-12T0910Z-the-net-http-response-fix-treats-the-17mb-heap-and-the-10gb-toast-has-never-been-autovacuumed.md)
- [🔴 **58 % of this estate's pg_cron edge dispatches leave NO trace in `pipeline_runs` — five jobs, 1,392/day, invisible to every instrument built on that table**](2026-09-12T0840Z-58-percent-of-pg-cron-edge-dispatches-leave-no-trace-in-pipeline-runs-and-the-mapping-to-build-it.md)
- [🚨 **The Top Shot 530 is CLOUDFLARE ERROR 1033 — the host's own tunnel is down, it is NOT a gated query, and the proof has been in our database since 2026-08-28**](2026-09-12T0805Z-the-top-shot-530-is-cloudflare-1033-the-host-tunnel-is-down-and-the-proof-was-in-our-db-all-along.md)
- [⭐⭐ **Two collections, two lanes, ONE defect: a candidate predicate that SELECTS ON THE COLUMN IT FILLS — and it is indistinguishable from a healthy drain the moment it finishes**](2026-09-12T0730Z-two-collections-two-lanes-one-defect-a-candidate-predicate-that-selects-on-the-column-it-fills.md)
- [⭐ **The missing All Day offer-fill lane, COSTED against M2's bar: +1.1 to +2.7 points, not the fix — and the already-MEDIUM check cut it by two thirds**](2026-09-12T0610Z-the-offer-fill-lane-costed-against-the-go-live-bar-is-plus-1-to-3-points-not-the-fix-for-m2.md)
- [🔴 **NINE lanes — including BOTH user-facing alert-delivery lanes — have run only on the GHA backstop for two days, 8 ticks/day instead of 96–2,016**](2026-09-12T0540Z-nine-lanes-including-user-facing-alert-delivery-have-run-only-on-the-gha-floor-for-two-days.md)
- [🔴 **`pinnacle-metadata-backfill` reported `ok` 63 times in a row while three of its four queues wrote NOTHING**](2026-09-12T0435Z-pinnacle-metadata-backfill-reported-ok-63-times-while-three-of-its-four-queues-wrote-nothing.md)
- [🚨 **The backstop FIRED, got a `202 {"accepted":true}`, and produced NOTHING — and all three of the monitor's suggested actions were wrong**](2026-09-12T0400Z-the-backstop-fired-got-a-202-and-produced-nothing-and-two-of-the-three-monitor-items-dissolve.md)
- [Daytime monitor — 2026-09-12T03:09Z (2026-09-11 20:09 PT): three candidates, DB not in a spell](2026-09-12T0309Z-daytime-monitor.md)
- [🔴 **`sales-counterparty-backfill` is PERMANENTLY EXHAUSTED and rescans BOTH `sales` partitions 286×/day to discard every row — 47% of ticks die on `statement timeout`**](2026-09-12T0117Z-sales-counterparty-backfill-is-permanently-exhausted-and-rescans-both-partitions-286-times-a-day.md)
- [⭐⭐ **The quiet window finally came, and it settles jobid 355 — BOTH prior proposed fixes were wrong, and the index it needs already exists**](2026-09-12T0115Z-the-quiet-window-finally-came-and-it-settles-jobid-355-both-prior-fixes-were-wrong.md)
- [Daytime monitor — 2026-09-12T00:10Z (2026-09-11 17:10 PT): IN a saturation spell, everything filed as a SYMPTOM](2026-09-12T0010Z-daytime-monitor.md)

## 2026-09-12 — 1 filing

- [⭐ **The quiet-window ranking that found a 36 % consumer — and the control that refuted #84 culprit**](2026-09-12T1500Z-the-quiet-window-ranking-that-found-a-36-percent-consumer.md)

## 2026-09-11 — 9 filings

- [Daytime monitor — 2026-09-11T18:08Z (11:08 PT): the saturation spell RECURRED, and every item is a symptom not a bug](2026-09-11T1808Z-daytime-spell-recurrence-and-pipeline-silences.md)
- [Daytime monitor — 2026-09-11T15:06Z (08:06 PT, first tick of day): healthy, one earlier spell already cleared](2026-09-11T1506Z-daytime-monitor.md)
- [🔴 **A LIVE saturation spell, caught mid-event, with a named culprit — a 50,000-row batch that usually takes 8 seconds**](2026-09-11T1330Z-a-live-saturation-spell-with-a-named-culprit-a-50000-row-batch-that-usually-takes-8-seconds.md)
- [🚨 **The instance is IO-STARVED right now — 34 active backends ALL blocked on IO, a 39-minute autovacuum on a 3.25 GB table, and 46–62% `maxDuration` kill rates on the heaviest lanes**](2026-09-11T1334Z-the-instance-is-io-starved-right-now-and-three-instruments-agree-on-the-same-cause.md)
- [⭐⭐ **#70 ANSWERED with an independent index — the All Day decline is REAL, our listing ingest is EXACT, and we are missing the entire accepted-offer lane (~24% of sales)**](2026-09-11T1030Z-70-answered-the-allday-decline-is-real-and-we-are-missing-the-entire-accepted-offer-lane.md)
- [🚨 **9,486 All Day sales record the Dapper CUSTODIAN as the buyer — the exact value this repo decided, in writing, "would be a lie"**](2026-09-11T1014Z-9486-allday-sales-record-the-dapper-custodian-as-the-buyer-which-this-repo-decided-was-a-lie.md)
- [🚨 **The parallel-circulation self-heal is a STRUCTURAL NO-OP, its audit table is a fabricated repair log, and its DB-invariant pin cannot see either**](2026-09-11T0927Z-the-parallel-circulation-selfheal-is-a-structural-no-op-and-its-pin-test-cannot-see-it.md)
- [Daytime monitor — 2026-09-11T03:09Z (≈20:09 PT 09-10): the 13-lane freeze is RESOLVED, and the one thread it leaves open](2026-09-11T0309Z.md)
- [🚨 HIGH — a 13-pipeline external-scheduler cluster STOPPED FIRING ~13:45–14:03Z 09-10 and has not run in ~10.7h](2026-09-11T0045Z.md)

## 2026-09-10 — 1 filing

- [🟡 **Top Shot pack supply is a 73-day-old snapshot, `pack_distributions.updated_at` says "4 hours", and the `data_stale` alert on that very table cannot see it**](2026-09-10T0002Z-topshot-pack-supply-is-a-73-day-old-snapshot-and-the-data_stale-alert-on-that-table-cannot-see-it.md)

## 2026-09-09 — 2 filings

- [Daytime monitor — 2026-09-08 ~23:06 PT (06:11Z): the retired `ingest` lane's watchlist row is now a permanent false `medium` stall](2026-09-09T0611Z-daytime-monitor.md)
- [🚨 **A nine-hour instance-wide saturation spell is IN PROGRESS, 270+ pg_cron jobs never STARTED, and the sentinel scored the blackout as WARN — a green badge**](2026-09-09T1900Z-nine-hour-saturation-spell-270-jobs-never-started-and-the-sentinel-scored-a-blackout-as-warn.md)

## 2026-09-08 — 6 filings


- [`pack_table_rows` warm probe crossed its slow-board cap after a week flat — LOW, and the arm is doing its designed job](2026-09-08T2110Z-daytime-monitor.md)

- [🔴 **The Top Shot sales ledger carries ~20,800 duplicate rows inside the live FMV window — and ~4.3 points of the go-live M1 metric rests on them**](2026-09-08T1915Z-topshot-sales-ledger-carries-20800-duplicate-rows-inside-the-live-fmv-window.md)
- [⭐ **Five lanes still fire into the dead Top Shot GraphQL host — ten days after its sibling was paused for exactly this**, and every one is a permanently-red instrument](2026-09-08T0530Z-five-lanes-still-fire-into-the-dead-topshot-gql-host-ten-days-after-its-sibling-was-paused.md)
- [⭐ **`v_offer_sanity_flags` is a CROSS-INSTRUMENT ARTIFACT, not a backlog — 98.9 % of its flags can NEVER clear**, because the view counts all offer types and the job that clears it deliberately excludes `subedition`/`serial`](2026-09-08T0110Z-offsan-is-a-cross-instrument-artifact-98-percent-of-its-flags-can-never-clear.md)

- [`topshot_atlas_market_events` grows ~90K rows / 45 MB a day with no retention — and four lanes now read it](2026-09-08T0015Z-the-atlas-events-table-grows-90k-rows-a-day-with-no-retention-and-four-lanes-now-read-it.md)

- [`v_offer_sanity_flags` = 1313 while the pipeline its own scorecard card names as the self-clear (`offers-sweep`) has been INACTIVE ~21h — re-measure the trend before touching anything](2026-09-08T0010Z.md)

## 2026-09-07 — 8 filings

- [⭐ **`refresh_atlas_pack_ev()` writes a fabricated `total_unopened = 0` and `pack_ev_latest` reads it as SOLD OUT — no row that function writes can ever be published as +EV**](2026-09-07T2135Z-refresh-atlas-pack-ev-writes-a-fabricated-total-unopened-zero-that-bars-every-atlas-row-from-the-ev-board.md)

- [✅ VERIFIED against the pre-fix baseline: the reconcile heartbeat fix takes logged ticks from 12/26 to 11/11 and gaps from 180 min to 30 — and the ONE blind spot it opens is named, with the closing field (`extra.no_op`) confirmed written-but-read-by-nothing](2026-09-07T2130Z-the-reconcile-heartbeat-fix-verified-and-the-one-blind-spot-it-opens.md)

- [⭐ **`/insights/pack-reality` renders an HONEST empty state (verified by rendered DOM) — but the 0311Z diagnosis is REFUTED: `pack_drop_pool` froze on 08-28 and the `atlas` pool is a 57-distribution July seed**](2026-09-07T1603Z-pack-reality-is-empty-because-the-pack-drop-pool-froze-on-08-28-and-the-atlas-pool-is-a-57-dist-july-seed.md)

- [✅ **`rpc-qa-scorecard` FIXED — the Sentinel card's pre-subedition regex (608 false amber → 0) and, found on contact, the FMV card's per-edition `LIMIT 1` lateral (77K → 16K buffers)**](2026-09-07T1545Z-qa-scorecard-sentinel-regex-and-fmv-lateral-fixed-artifact-updated.md)

- [`detect_stalled_pipelines()` false-positive MEDIUM on `wmc-metadata-reconcile` — the watchlist keys on `pipeline_runs` recency, but the job legitimately writes no row on a no-op tick](2026-09-07T0611Z-daytime-monitor.md)

- [`/insights/pack-reality`'s backing board is GENUINELY EMPTY, not broken — verify the public page renders an honest empty state](2026-09-07T0311Z-daytime-monitor.md)

- [UFC serves six anon-public soft-404 tab URLs and three other collections do too (~19) — none is in the sitemap, all predate the sniper retirement, and the redirect pin is deliberately ONE-WAY so it cannot claim the class is handled](2026-09-07T0330Z-ufc-serves-six-anon-public-soft-404s-and-three-other-collections-do-too.md)

- [⚠ HALF REFUTED BY ITS AUTHOR 2026-09-07 — the truncation claim is WRONG (one caller slices 200 before a route that chunks at 500, so the loop runs once and `break` discards nothing; now pinned); what survives is a failed read rendering as a dash, whose RATE is UNMEASURABLE (the route produces zero log lines in a short window, so the positive control fails, and wider windows time out)](2026-09-07T0200Z-best-offers-breaks-out-of-its-chunk-loop-on-error-and-a-missing-offer-renders-as-a-dash.md)

## 2026-09-06 — 2 filings

- [⚠ **`rpc-qa-scorecard`'s "Sentinel leak (48h)" card uses a PRE-SUBEDITION regex and shows 608 valid rows in the amber watch band**](2026-09-06T0315Z-qa-scorecard-sentinel-card-uses-a-pre-subedition-regex-and-flags-608-valid-rows.md)

- [🚨 **`allday-lock-refresh`: ONE wallet's Flow-400 marks whole 20K–33K-row runs `ok=false` — onset 2026-09-05 05:23Z**](2026-09-06T1510Z-daytime-monitor.md)

## 2026-09-05 — 18 filings

- [⚠ **`topshot-badge-set-backfill`'s cadence-stall arm is a FALSE POSITIVE — the pipeline was deliberately unscheduled 2026-09-04, but its stall arm was seeded the same day and now trips**](2026-09-05T1810Z-badge-set-backfill-stall-arm-is-a-false-positive-the-pipeline-was-deliberately-unscheduled.md)

- [🚨 **DEP0169 root-caused at last: it is `node-fetch` via `cross-fetch`, NOT the Flow SDK — and it fires on USE, not on import**](2026-09-05T1746Z-dep0169-root-caused-it-is-node-fetch-via-cross-fetch-not-the-flow-sdk-and-it-fires-on-use-not-import.md)

- [✅ **The `ipfs-media` gateway-race watch is DISCHARGED — 90% fewer timeouts at matched hours, with a positive control that rules out "the upstream just recovered"**](2026-09-05T1645Z-the-ipfs-media-gateway-race-watch-is-discharged-with-a-positive-control-and-get-runtime-errors-relative-windows-disagree-with-iso-ones.md)

- [🚨 **The platform's #1 physical reader finished its job 20 hours ago and still runs at full drain cadence**](2026-09-05T1630Z-the-platforms-1-physical-reader-finished-its-job-20-hours-ago-and-still-runs-at-full-drain-cadence.md)

- [**The edition-page alarm I nearly raised was a UNITS ERROR, the `query_sql` attribution HOLDS under its own falsifier, and the #1 physical reader has changed hands**](2026-09-05T1626Z-the-edition-page-alarm-was-a-units-error-and-the-fmv-recalc-attribution-holds-under-its-own-falsifier.md)
- [**The image-weight finding is REAL and bigger than filed — but 90% of it is `assets.nbatopshot.com`, not our proxy — and the free 190x lever destroys transparency**](2026-09-05T1400Z-the-image-weight-is-real-but-90pct-is-the-CDN-not-our-proxy-and-the-free-190x-lever-flattens-alpha.md)
- [**2,334 editions serve 2.6–7.7 MB full-resolution PNGs for a 281 px tile — and the proxy that could fix it is ours**](2026-09-05T1235Z-2334-editions-serve-multi-MB-full-resolution-pngs-for-a-281px-tile-and-we-own-the-proxy.md)
- [**The unmapped-sales "drain has STALLED" test fires 46% of the time on a working drain — and the obvious retune measures WORSE**](2026-09-05T1125Z-the-unmapped-drain-stall-test-fires-46pct-of-the-time-and-the-obvious-retune-is-worse.md)
- [**Two NEW route timeouts appeared in 18h, they share ONE root (`pack_ev_latest`), and the cheap fix is REFUTED**](2026-09-05T1120Z-two-new-route-timeouts-share-one-root-and-pack_ev_latest-has-no-materialized-alternative.md)
- [**Two DB pins went stale on 2026-09-04 and the daily drift check has been red since — the repo is COMPLETE, the pins were just not repointed**](2026-09-05T1040Z-two-db-pins-went-stale-on-09-04-and-the-daily-drift-check-has-been-red-since.md)
- [**Three Top Shot pipelines died on 2026-08-29 with the dead host — not 09-04 — and the fleet alarm has been unreadable for 8 days**](2026-09-05T1015Z-three-topshot-pipelines-died-on-08-29-with-the-dead-host-and-the-fleet-alarm-has-been-unreadable-since.md)
- [**The entire NFL All Day `Genesis` set (352 editions, Series 1, all ULTIMATE 1/1) has NO ART at its upstream — 47 of 52 images blank on its set page, 0 of 15 sampled ids return 200 against 15 of 15 in the control group — and the new blank-art smoke gate is scoped to media-PROXY routes so it cannot see it**](2026-09-05T0940Z-the-entire-allday-genesis-set-has-no-art-upstream-and-the-new-blank-art-gate-is-scoped-past-it.md)

- [**The `entity-smoke` `/moment/` flake is NOT a soft-404 and NOT a slow cold render — 0 reproductions in 28 attempts**](2026-09-05T1100Z-the-entity-smoke-moment-flake-is-not-a-soft-404-and-i-could-not-reproduce-it-in-28-attempts.md)

- [**Candy MLB sale art is STILL blank on `/insights/top-sales` — today's fix moved the failure from a CSP refusal to a 502, and the obvious next fix (follow the redirect) is measurably wrong too**](2026-09-05T0700Z-candy-mlb-sale-art-is-still-blank-on-top-sales-and-following-the-redirect-would-not-fix-it.md)
- [**The upstream cause of the fabricated-empty is COUNTED — 197 sites of the `const { data } = await` shape, of which only 28 can reach a reader, and about 1 in 9 of THOSE is a real false claim**](2026-09-05T0555Z-the-upstream-cause-of-the-fabricated-empty-is-counted-197-sites-but-only-28-can-reach-a-reader.md)
- [**`sales-counterparty-backfill` finished its walk 40 hours ago and has been re-scanning a provably-empty range ever since — 470 of 470 ticks drained, ~40 min of DB time a day, and it is the platform's #3 reader**](2026-09-05T0510Z-sales-counterparty-backfill-finished-its-walk-40-hours-ago-and-has-been-rescanning-a-dead-range-ever-since.md)
- [**The fmv-recalc inline-scan census is COMPLETE — all seven measured individually, 872,113 → 559,578 buffers a tick (−36%), and the biggest one was NOT the one that looked worst**](2026-09-05T0430Z-the-fmv-recalc-inline-scan-census-is-complete-two-fixed-three-measured-and-not-worth-touching.md)
- [**The All Day sniper 403 hypothesis is REFUTED from CODE (no telemetry needed), and the 09-04 ledger's post-fix number was measured at `p_min_discount = 10` while the route DEFAULTS to `0` — warm-vs-warm that is 126,455 buffers / 2,548 ms against the recorded 10,587 / 131 ms, i.e. 12× the buffers on the path a user gets by opening the page**](2026-09-05T0130Z-the-allday-sniper-403-hypothesis-is-refuted-and-the-post-fix-number-was-measured-at-a-non-default-parameter.md)

## 2026-09-04 — 3 filings

- [**`get_pack_lifecycle` is the platform's top user-facing slow read (56 bound-exceeded events / 50 users in 3 days, 3,129 ms mean over 10,455 calls, max pinned at the 30 s `statement_timeout`) — and it is NOT a plan defect: warm, its heaviest leg is 23 BUFFERS with every join an index scan, and 13 of those 23 were still PHYSICAL READS on the SECOND consecutive run. That is the SMALL-instance IO signature, not this function's shape**](2026-09-04T1430Z-pack-lifecycle-is-the-top-user-facing-slow-read-and-it-is-not-a-plan-defect.md)
- [**`query_sql` is the database's #1 reader over 24 h (2,171 calls, 12.1 M blocks, 3.4× the next statement) and `fmv-recalc` owns it — seven ad-hoc scans per run × 153 runs/day; invisible by construction because every query through the wrapper shares one queryid** — measured, not shipped; the fix is named functions per scan + a scoped index, a daytime pass](2026-09-04T0500Z-query-sql-is-the-top-reader-and-fmv-recalc-owns-it-seven-ad-hoc-scans-per-run.md)
- [**Three more Top Shot pipelines still hit the decommissioned host every day (`topshot-badge-set-backfill` 4/0, `topshot-catalog-backfill` 1/0, `topshot-misattrib-drain` 1/0 — honest failures, wasted calls, pause-or-port is a decision), and ~80 pipelines with ≥7 active days have NO cadence-watchlist arm (the gap `sales-serial-backfill` sat in for a month) — ⛔ do NOT auto-seed 80 arms from the night pass; a data-driven seed table needs a human read first**](2026-09-04T0220Z-three-more-top-shot-pipelines-hit-the-dead-host-daily-and-most-pipelines-have-no-watchlist-arm.md)

## 2026-09-03 — 12 filings

- [**✅ RESOLVED 09-03 (echo of the self-healer; pack-opens is the known abort class) — Daytime monitor 21:10Z — `topshot_impossible_parallel_serials` newly BREACHING at 8 (breach_at 3), and `allday-pack-opens-backfill` has gone from transient to WEDGED on one poison block range**](2026-09-03T2110Z.md)
- [**✅ RESOLVED 09-03 (board materialised instead) — Daytime monitor 18:07Z — `candy_scarcity_board` sits AT the 3000 ms liveness floor and flickers `public_board_slow_count` into BREACH on ordinary variance**](2026-09-03T181027Z.md)
- [**`days_to_drain` says 25 days while the resolver's own telemetry says `onchain_unproductive: true` — the AllDay unmapped pile is at its FLOOR, not draining**](2026-09-03T1430Z-the-unmapped-backlog-eta-says-25-days-while-the-resolver-reports-onchain-unproductive.md)
- [**2 in 7 IPFS transfers die MID-BODY after a successful headers read — and the obvious cause is refuted by the same seven rows**](2026-09-03T1400Z-two-in-seven-ipfs-transfers-die-mid-body-and-it-is-not-about-size.md)
- [**`/api/sniper-feed` is a LATENCY problem and NOT a cost one — and none of its reads is bounded**](2026-09-03T0850Z-sniper-feed-is-a-latency-problem-and-not-a-cost-one-and-none-of-its-reads-is-bounded.md)
- [**The per-route wall map exists now, and its first fleet sweep DIAGNOSES ITS OWN mapping errors**](2026-09-03T0830Z-the-per-route-wall-map-exists-now-and-its-first-sweep-diagnoses-itself.md)
- [**A KILLED tick can carry a CLEAN heartbeat correlation — measured 90 minutes after converting the route**](2026-09-03T0800Z-a-killed-tick-can-carry-a-clean-heartbeat-correlation.md)
- [**54 bounded fetches read their body OUTSIDE the catch — but the scan OVER-REPORTS and nobody should act on the list as-is**](2026-09-03T0745Z-fifty-four-bounded-fetches-read-their-body-outside-the-catch-and-the-scan-over-reports.md)
- [**The two permanently-red workflows are ONE CAUSE AND ONE CONSEQUENCE — the fleet alarm is pinned CRITICAL by a condition that is deliberately unresolved**](2026-09-03T0445Z-the-two-permanently-red-workflows-are-one-cause-and-one-consequence.md)
- [**D25 is TWO populations, and the big one is a unit mismatch — 895 of 895, with the obvious remedy measured dead**](2026-09-03T0430Z-d25-is-two-populations-and-the-big-one-is-a-unit-mismatch-895-of-895.md)
- [**R29 — the three obvious levers for `job startup timeout` are all measured dead, and the load story does not survive its own control**](2026-09-03T0400Z-r29-the-three-obvious-levers-for-pgcron-startup-timeouts-are-all-measured-dead.md)
- [**45 scheduled pipelines skipped 66 ticks inside one two-hour band, and NO alert on this platform could fire**](2026-09-03T0300Z-fortyfive-scheduled-pipelines-skipped-66-ticks-in-one-two-hour-band-and-nothing-could-alert-on-it.md)

## 2026-09-02 — 18 filings

- [⚡ **Sixteen routes filter `fmv_current` by an id list — and THREE ids cost the same 1.33M buffers as five hundred**](2026-09-02T2329Z-sixteen-routes-filter-fmv_current-by-an-id-list-and-three-ids-cost-the-same-1_33m-buffers-as-five-hundred.md)
- [⏳ **Two pg_cron failures caught by the daytime sweep — and BOTH are stale pre-fix runs, each superseded by a same-day ship**](2026-09-02T1510Z-daytime-two-pgcron-fails-onchain-rekey-perm-and-challenge-costs-timeout.md)
- [Fourteen of 52 cron-route pipeline names have no runs, and seven ran for weeks then STOPPED — found after fixing one of them by mistake](2026-09-02T2015Z-fourteen-cron-route-pipeline-names-have-no-runs-and-seven-of-them-stopped-mid-august.md)
- [⚡ **The concierge is unreachable on every page anonymous traffic lands on — and signing in makes it 8x more restrictive**](2026-09-02T0645Z-the-concierge-is-unreachable-on-every-page-anonymous-traffic-lands-on.md)
- [🚨 All 14 pg_cron HTTP jobs put their gate key in the URL and none uses a header — and the standing "no hardcoded credentials" probe greps origin/main, so it is structurally blind to every one of them](2026-09-02T1100Z-all-14-pg-cron-http-jobs-put-their-gate-key-in-the-URL-and-the-credential-probe-cannot-see-them.md)
- [Ten Top Shot players (and one Golazos) are split across two spellings of their own name, 55 editions stranded on a second near-empty page — Alperen Şengün's page says 43 when he has 74; the cause is two ingests disagreeing, NOT diacritics](2026-09-02T1045Z-ten-topshot-players-are-split-across-two-spellings-and-half-their-editions-sit-on-a-second-page.md)
- [`wallet_moments_cache` carries 19 indexes / 1,924 MB against a 941 MB heap — and ranking them by scan count would have recommended dropping the hottest one, created 5.6 hours earlier](2026-09-02T0940Z-wmc-carries-19-indexes-and-scan-counts-lie-about-which-are-cold.md)
- [⚠ HALF RESOLVED, falsifier NOT met — `sales-serial-backfill`'s Top Shot lane is 100% dead for 6 days (`1033`/`1015` still growing at +245/+436 per 6 h), and `pipeline_runs` only says `unknown`; the AllDay half is EMPTY across every failure reason, not just the `not_in` treadmill the filing scoped](2026-09-02T0855Z-sales-serial-backfill-topshot-lane-is-100pct-dead-for-6-days-and-pipeline_runs-only-says-unknown.md)
- [106 `audit_*` scratch tables hold 221 MB of a 14 GB database — and that number is the argument for leaving them alone](2026-09-02T0815Z-106-audit-scratch-tables-are-221mb-of-14gb-and-that-is-the-argument-for-leaving-them.md)
- [pack-EV / `fmv_current`: both owed measurements are done in a QUIET window — and one of them refutes the earlier refutation's mechanism](2026-09-02T0700Z-pack-ev-the-two-owed-measurements-are-done-and-one-refutes-the-refutation.md)
- [`/api/collection-stats` runs the same 19,942-probe FMV scan twice per request — and the number it recomputes is already precomputed](2026-09-02T0545Z-collection-stats-runs-the-same-19942-probe-fmv-scan-twice-per-request.md)
- [Top Shot on Flow EVM / OpenSea — BUILD IT, and `tokenId` is already our `moment_id`](2026-09-02T0430Z-topshot-on-flow-evm-build-it-tokenid-is-momentid.md)
- [✅ HALF SHIPPED — `resolve-topshot-stubs` has written 37 rows in 74,800 attempts over 36 days; 267 of the 520 stuck editions were named from `wallet_moments_cache`, which had the answer all along, and the queue is now 253](2026-09-02T0435Z-resolve-topshot-stubs-has-written-37-rows-in-74800-attempts-over-36-days.md)
- [Candy secondary is no longer Magic-Eden-only — OpenSea added Solana, Candy is a launch partner](2026-09-02T0400Z-candy-secondary-is-no-longer-magic-eden-only-opensea-added-solana.md)
- [⚠ FIX VERIFIED, capacity gap untouched — `lock-check-batch` is at full rate, fully green, and starving 237 of 249 wallets (Top Shot's user-wallet share of checks went 0% → 100% at constant throughput; a breadth arm would have called that a regression)](2026-09-02T0330Z-lock-check-is-full-rate-and-starving-237-of-249-wallets.md)
- [📏 `backfill_wmc_metadata_from_editions` had 152 rows left, now filled — and its partial index is a 100% false positive](2026-09-02T0215Z-wmc-metadata-backfill-is-done-and-its-partial-index-is-now-a-100pct-false-positive.md)
- [The deploy tool's *safe* default was the outage — and a green pipeline proved nothing about the secret](2026-09-02T0045Z-the-deploy-tools-safe-default-was-the-outage-and-a-green-pipeline-proved-nothing-about-the-secret.md)
- [Daytime monitor — offers-sweep logs Top Shot 530 as a hard fail on half its ticks](2026-09-02T0010Z-daytime-monitor-offers-sweep-logs-topshot-530-as-hard-fail-on-half-its-ticks.md)

## 2026-09-01 — 23 filings

- [2026-09-01T2218Z — `/api/public/ipfs-media/(cid)` fails 86 % of the time, and 97 % of those failures are OUR 8-second abort, not ipfs.io saying no](2026-09-01T2218Z-the-ipfs-proxys-own-instrumentation-answers-its-question-97pct-of-its-502s-are-our-abort.md)
- [2026-09-01T21:00Z — a public team-page RPC was over its own timeout, and the obvious fix was a regression](2026-09-01T2100Z-a-public-team-page-rpc-was-over-its-own-timeout-and-the-obvious-fix-was-a-regression.md)
- [2026-09-01T20:18Z — the queued index drop would have turned its own verify function into a hard ERROR](2026-09-01T2018Z-the-queued-index-drop-would-have-turned-its-own-verify-into-a-hard-error.md)
- [2026-09-01T1858Z — this pass is the duplicate task, and the queued index lever is confirmed](2026-09-01T1858Z-this-pass-is-the-duplicate-task-and-the-index-lever-is-confirmed.md)
- [2026-09-01T1818Z — the task created to fix the push blocker has the same missing binding, and the reindex verify has flipped back to `ok:false`](2026-09-01T1818Z-the-task-created-to-fix-the-push-blocker-has-the-same-missing-binding.md)
- [2026-09-01T1058Z — three passes booked `shared_blks_read` and called it "blocks", and the #4 consumer is 19× bigger than its own post-ship watch says](2026-09-01T1058Z-three-passes-booked-reads-as-blocks-and-the-smoke-suite-is-19x-bigger-than-its-watch-says.md)
- [2026-09-01T1030Z — the instance's #2 consumer fails 48% of its calls, and the REINDEX that was supposed to relieve it lost a third of its gain in 30 hours](2026-09-01T1030Z-the-number-two-consumer-is-48pct-failing-and-the-reindex-gain-is-a-third-gone.md)
- [Inbox — 2026-09-01T08:59Z (cloud) — the saturation diff's #1 line item was my own measurement channel](2026-09-01T0859Z-the-diffs-top-line-item-was-my-own-measurement-channel.md)
- [2026-09-01T0818Z — the top non-self consumer was not just expensive, it was FAILING 46% of the time, and no instrument could see it](2026-09-01T0818Z-the-top-consumer-was-46pct-failing-and-no-instrument-could-see-it.md)
- [2026-09-01T07:00Z — the job that fills AllDay's open counter selects on that counter being empty](2026-09-01T0700Z-the-job-that-fills-alldays-open-counter-selects-on-that-counter-being-empty.md)
- [A post-ship baseline taken *after* the apply is still not a clean A/B — the warm-up buckets are](2026-09-01T0630Z-a-post-ship-baseline-after-the-apply-is-still-not-a-clean-ab-the-warm-up-buckets-are.md)
- [Inbox — 2026-09-01T04:58Z (cloud pass)](2026-09-01T0458Z-the-obvious-port-of-last-nights-win-would-silently-stop-refreshing-1133-wallets.md)
- [2026-09-01T04:30Z — the instance's #1 per-call consumer is a ~48 GB/day scan whose only cloud-shippable fixes are both already refuted](2026-09-01T0430Z-top-per-call-consumer-is-48gb-day-and-its-only-cloud-shippable-fixes-are-both-refuted.md)
- [2026-09-01T0219Z — the instance's top pg_stat_statements line item was misattributed for four passes, and the read nobody could explain is an ordering-index walk](2026-09-01T0219Z-the-instances-top-consumer-was-misattributed-for-four-passes.md)
- [2026-09-01T0100Z — the top non-self consumer is UNCHUNKED (~4,000+ ids), so it is not the UFC functions — and one of the two named callers is not even deployed](2026-09-01T0100Z-the-top-non-self-consumer-is-unchunked-and-one-named-caller-is-not-deployed.md)
- [2026-09-01T0030Z — the top non-self consumer is a known anti-pattern in two UFC edge functions, and both of my explanations for its cost are wrong](2026-09-01T0030Z-the-top-non-self-consumer-is-a-known-anti-pattern-and-both-of-my-explanations-for-it-are-wrong.md)
- [Daytime monitor — 2026-09-01T21:11Z](2026-09-01T2111Z-daytime-monitor.md)
- [🚨 `sales-counterparty-backfill` has walked past Flow's spork wall — and the wall answers HTTP 200, so 288 of 288 runs a day recover nothing](2026-09-01T0600Z-sales-counterparty-backfill-has-walked-past-the-flow-spork-wall-and-the-wall-answers-200.md)
- [🚨 fmv-recalc's historical-sales fallback has been failing on 100% of runs, reporting `historicalFallback=0`, and starving 4,277 editions of FMV](2026-09-01T0530Z-fmv-recalc-historical-fallback-has-been-failing-on-100pct-of-runs-and-reporting-zero.md)
- [⚡ **The instance's top consumer fetched 9,613 rows to reject them — and the planner would not take the fix without a fence**](2026-09-01T0410Z-the-instances-top-consumer-fetched-9613-rows-to-reject-them-and-the-planner-would-not-take-the-fix-without-a-fence.md)

---

- [⛔ The queued `edition_fmv_current` swap in fmv-recalc would have corrupted 4 editions — the LATERAL is the fix, and it is proven equivalent](2026-09-01T0400Z-edition-fmv-current-is-not-substitutable-in-fmv-recalc-and-the-lateral-is.md)
- [item 13 names four functions as carrying the `plan_cache_mode` fix; the catalog says two](2026-09-01T0300Z-item-13-names-four-functions-as-fixed-and-the-catalog-says-two.md)
- [Daytime monitor candidate — 2026-09-01T00:12Z (RESOLVED: arm self-healed 10 → 0; hypothesis refuted)](2026-09-01T0012Z-daytime-monitor.md)

## 2026-08-31 — 25 filings

- [The edition-page family seq-scanned a 31 MB table twice per call — and a 40-minute diff over-ranked a daily job by 36×](2026-08-31T2320Z-the-edition-page-family-seq-scanned-a-31mb-table-twice-per-call-and-a-40-minute-diff-over-ranked-a-daily-job-36x.md)
- [2026-08-31T22:35Z — three public boards blew up together at 20:28Z, and the two biggest consumers in that window were the pass's own measurement queries](2026-08-31T2235Z-three-public-boards-blew-up-together-and-the-passs-own-queries-were-the-top-two-consumers.md)
- [2026-08-31T21:10Z — the #1 production read has no caller in the repo, and its obvious fix is 480x worse](2026-08-31T2110Z-the-top-production-read-has-no-caller-in-the-repo-and-fmv-current-is-480x-worse.md)
- [2026-08-31T20:20Z — the pass was spending 18 M buffers to measure a 31 MB table, and both autonomous tasks are unbound](2026-08-31T2020Z-the-pass-spent-18m-buffers-measuring-a-31mb-table-and-both-autonomous-tasks-are-unbound.md)
- [The `topshot_impossible_parallel_serials` arm went red on a LIVE WNBA MINT — and it is structurally incapable of ever reading the healed state](2026-08-31T1920Z-the-impossible-parallel-arm-measures-four-minutes-before-its-own-healer-and-a-live-wnba-mint-made-that-visible.md)
- [A ~253 MB index set sat unused behind a `NULLS LAST` clause on the public player pages](2026-08-31T1835Z-a-253mb-index-set-sat-unused-behind-a-nulls-last-clause-on-the-player-pages.md)
- [2026-08-31T17:25Z — Both "device-bound" autonomous tasks are now measured firing cloud-only, 40 minutes apart, and three migrations are stranded](2026-08-31T1730Z-both-device-bound-tasks-are-firing-cloud-only-and-three-migrations-are-stranded.md)
- [2026-08-31T16:35Z — the replacement "device-bound, can push" task fired cloud-only, so the defect it was created to fix reproduced on its first pass I can see](2026-08-31T1635Z-the-device-bound-v2-task-fired-cloud-only-and-reproduced-the-defect-it-was-created-to-fix.md)
- [2026-08-31T15:15Z — the top read consumer was rebuilding 27,160 rows to keep 796, and applying none of them](2026-08-31T1515Z-the-top-read-consumer-was-rebuilding-27160-rows-to-keep-796-and-apply-none.md)
- [2026-08-31T1330Z — the 146k-row backlog was real, its empty player names were feeding a dead host, and one collection's share of it is a catalogue gap not a backlog](2026-08-31T1330Z-the-146k-row-backlog-was-real-and-its-empty-player-names-were-feeding-a-dead-host.md)
- [2026-08-31T1120Z — the #1 exec-time consumer was rejecting rows it had already paid to fetch, and the pipeline behind it is 3.3% productive](2026-08-31T1120Z-the-1-exec-time-consumer-was-rejecting-rows-it-had-already-paid-to-fetch.md)
- [The 08-30 "it is winning" verdict on `refresh_wmc_fmv_drift_active` is REFUTED by its own falsifier: the cutoff advanced 0.51 seconds in 5 minutes 47](2026-08-31T0715Z-the-drift-sweeps-cutoff-advanced-half-a-second-in-six-minutes-and-the-build-is-eating-its-own-budget.md)
- [90% of every uncached moment-image load 502s, and the route's own instrumentation now names the cause: our 8-second abort, not a dead object](2026-08-31T0710Z-ninety-percent-of-uncached-moment-art-502s-on-our-own-eight-second-abort.md)
- [The AllDay pull drain's premise expired: it now costs ~7% of all instance disk reads to resolve ~63 rows a day, and the backlog it is nibbling at clears in ~50 years](2026-08-31T0510Z-the-allday-pull-drain-costs-7pct-of-instance-reads-to-resolve-63-rows-a-day-and-its-backlog-clears-in-50-years.md)
- [2026-08-31T01:10Z — Top Shot player matching is a no-op because the roster holds 174 of 1,432 names](2026-08-31T0110Z-topshot-player-matching-is-a-no-op-because-the-nba-roster-holds-174-of-1432-names.md)
- [Daytime monitor — 2026-08-31 ~21:10Z (RESOLVED: arm self-healed 10 → 0)](2026-08-31T2111Z-daytime-monitor.md)
- [⛔ **`atlas-proxy` is DEPLOYED and the lane it exists to open is MEASURED DEAD — Cloudflare egress is Atlas-WAF-blocked, 46 of 46**](2026-08-31T1521Z-atlas-proxy-is-DEPLOYED-and-MEASURED-DEAD-cloudflare-egress-is-atlas-waf-blocked.md)

- [📏 **Five `postgres` cron jobs are clipped at the DB-default 120 s purely because their command lacks the two-statement `SET statement_timeout` prefix — 18 siblings already have it**](2026-08-31T1425Z-five-postgres-cron-jobs-are-clipped-at-the-db-default-120s-because-their-command-lacks-the-SET-prefix.md)

- [🚨 **REFUTED — the drift sweep's own falsifier overturns the 07:1xZ filing, and `last_cutoff` climbs a STAIRCASE, not a ramp**](2026-08-31T0920Z-the-drift-sweeps-own-falsifier-refutes-the-0710Z-filing-the-cutoff-is-a-staircase.md)

- [✅ **SHIPPED — a 2026-07-05 correctness repoint orphaned BOTH partial indexes behind `get_serial_backfill_targets`, and 107 "fileless" migrations are stamp drift**](2026-08-31T0935Z-the-0705-repoint-orphaned-both-partial-indexes-and-107-fileless-migrations-are-stamp-drift.md)

- [✅ **ANSWERED — Top Shot FMV freshness recovered, but the legacy host is STILL 530: the recovery is sourced elsewhere and the queued items do NOT auto-clear**](2026-08-31T0610Z-daytime-monitor-topshot-legacy-endpoint-freshness-recovered-reassess-queued-studio-migration-and-packev-unpause.md)

- [⚠ **PARTLY RETRACTED — the fleet alarm is permanently CRITICAL, and the real point is that its clearing condition is OUTSIDE the estate**](2026-08-31T0700Z-the-fleet-alarm-went-permanently-critical-tonight-because-a-CORRECT-detector-is-red.md)

- [✅ **CLOSED (characterisation) — jobid 71 is NOT retirable — it is the SOLE feeder for 89 of 598 Top Shot packs — and its daily working set is FROZEN**](2026-08-31T0620Z-jobid71-is-not-retirable-it-is-the-sole-feeder-for-89-packs-and-its-working-set-is-frozen.md)

- [📏 **`mv_pack_ev_latest` touches 304,034 buffers to produce 1,855 rows — the rewrite is equivalence-proven at 17.2× fewer, and it is a DROP…CASCADE**](2026-08-31T0545Z-mv-pack-ev-latest-reads-304k-buffers-to-produce-1855-rows-and-the-rewrite-is-equivalence-proven.md)

- [✅ **CLOSED — the pack-EV watermark gate skips single digits, not the ~50% it was sized for — `count(DISTINCT hour)` cannot see sub-hourly cadence**](2026-08-31T0525Z-the-pack-ev-watermark-gate-skips-12pct-not-50pct-because-distinct-hours-saturates.md)

---

## 2026-08-30 — 13 filings

- [The Pinnacle buyer resolver has been blind for 17 days, and its status board reported **0 unresolved** the whole time](2026-08-30T0310Z-the-pinnacle-resolver-was-blind-to-null-buyers-for-17-days-and-its-status-board-read-zero-unresolved.md)
- [`/api/collection-moments` fails **10 of 18 requests** and the cause is heap fetches on two hot tables, not the query shape](2026-08-30T0112Z-collection-moments-fails-10-of-18-and-the-cause-is-heap-fetches-not-the-query-shape.md)
- [✅ **RESOLVED — `refresh_mv_pack_ev_latest`'s pin is repointed, and the trap was MEASURED: unseeded, the index probe raises nothing at all**](2026-08-30T2350Z-the-pack-ev-pin-is-stale-and-the-obvious-fix-silently-guts-the-concurrently-invariant.md)

- [✅ **RESOLVED — the pack-reality +EV board is dark BY MARKET, not by a NULL default; the filing's own proposed fix is refuted**](2026-08-30T2115Z-daytime-monitor-pack-reality-board-went-dark-today-as-preoutage-rows-aged-out-and-revived-ev-is-null-depletion.md)

- [🚨 **Top Shot has moved to ATLAS — and Atlas is reachable from the DATABASE, with no operator action**](2026-08-30T1610Z-topshot-has-moved-to-atlas-and-atlas-is-reachable-from-the-database.md)

- [**Daytime monitor — the grail-MV cadence arm is now too tight for its new hourly pg_cron form**](2026-08-30T1510Z-daytime-monitor.md)

- [⛔ **Falsifier re-run: the Studio Top Shot index is STILL empty — and all four candidate ask sources are now measured. There is no replacement.**](2026-08-30T1530Z-falsifier-re-run-no-source-exists-for-broad-topshot-asks-all-four-candidates-measured.md)

- [⛔ **A one-time `ENABLE ROW LEVEL SECURITY` does NOT hold on a table another session DROPs and re-CREATEs — proven twice in ten hours**](2026-08-30T1410Z-a-one-time-rls-alter-does-not-hold-on-a-table-another-session-recreates.md)

- [✅ **ACTIONED — the Top Shot 530 outage: only pack-pool was paused, so `offers-sweep` and `topshot-moments-hydrator` kept firing 100%-failing runs at the dead host**](2026-08-30T0311Z-topshot-530-outage-only-pack-pool-was-paused-offers-sweep-and-moments-hydrator-still-hammer-the-dead-endpoint.md)

- [🚨 **`sales-counterparty-backfill` walked past the mainnet19 spork — and the access node answers 200 WITH NOTHING, so nothing can tell**](2026-08-30T0300Z-the-counterparty-backfill-walked-past-the-mainnet19-spork-and-the-node-answers-200-with-nothing.md)

- [**The pack-reality drain is a dead POOL source, not a dead ASK source — and the pool does not need refreshing**](2026-08-30T0230Z-the-pack-reality-drain-is-a-dead-pool-source-not-a-dead-ask-source-and-the-pool-does-not-need-refreshing.md)

- [⛔ **R58 REFUTED — the 13 setless sets do not "render empty", they 404, and the real finding is 8 name-TRUNCATION artifacts**](2026-08-30T0130Z-R58-REFUTED-the-13-setless-sets-render-no-page-at-all-they-404.md)

- [✅ **RESOLVED — board-liveness wrote a FRESH 999 to both `public_board` arms; it is the DESIGNED inconclusive sentinel, not a new failure**](2026-08-30T0014Z-board-liveness-wrote-a-FRESH-999-to-both-arms-not-the-documented-timeout-stale-carry.md)

## 2026-08-29 — 19 filings

- [The visibility-map class was ranked by the wrong instrument — and following the right one found two pack-sales MVs reading **19× their own table**](2026-08-29T0320Z-the-visibility-class-was-ranked-by-the-wrong-instrument-and-two-pack-sales-mvs-read-19x-their-table.md)
- [ADDENDUM to `2026-08-29T0241Z-pack-rips-insert-rate-measured-...` — the rate is corroborated by a second instrument and is ~2.5× higher, and the insert path is the *smaller* of the two drivers](2026-08-29T0320Z-ADDENDUM-pack-rips-rate-corroborated-and-the-driver-is-updates-not-inserts.md)
- [⛔ **GitHub Actions does not honour our schedules — 14.9% of runs start on time, and the DAILY guards run up to 12 HOURS late**](2026-08-29T2230Z-github-actions-schedules-are-not-honoured.md)

- [⛔ **Four surfaces still publish a 30h-old ask as current — and each needs a PAYLOAD change, not a rendering one**](2026-08-29T2230Z-four-surfaces-still-publish-a-30h-old-ask-as-current-and-each-needs-a-payload-change.md)

- [⛔ **There is NO Studio replacement for Top Shot moment asks — the schema is there, the DATA is not**](2026-08-29T2200Z-there-is-no-studio-replacement-for-topshot-moment-asks-the-schema-is-there-the-data-is-not.md)

- [⚠ **`fmv-recalc` has completed NOTHING for 90 minutes and `fmv_sweep_wedge_hours` is BREACHING — and it kept killing AFTER the IO band cleared**](2026-08-29T2030Z-fmv-recalc-has-completed-nothing-for-90-minutes-and-the-wedge-arm-is-breaching-after-the-band-cleared.md)

- [**Applying my own Class C recommendation: jobid 237 is the SAME defect as 211, and #42's triage query still ranks the already-FIXED jobid 211 first**](2026-08-29T1850Z-applying-my-own-class-C-recommendation-jobid-237-is-the-same-defect-as-211-and-the-triage-query-still-ranks-a-FIXED-job-first.md)

- [⛔ **CORRECTION to my own filing 12 h old — jobid 211 was fixed by an INDEX, and #42's Class C signature is REFUTED on its own exemplar**](2026-08-29T1815Z-CORRECTION-my-own-jobid-211-dosimeter-filing-is-superseded-an-index-fixed-it-and-42s-class-C-signature-is-wrong.md)
- [⚠ **Daytime monitor 18:06Z — the IO band is materially WORSE than yesterday and has crossed a new threshold: a LIGHT catalog function now times out**](2026-08-29T1806Z-daytime-IO-band-materially-worse-than-yesterday-light-catalog-fn-now-times-out.md)

- [🚨 **The saturation breaker counts failures that touch NO database — so a Top Shot API outage is throttling sales-history backfills for FOUR collections**](2026-08-29T1830Z-the-saturation-breaker-counts-failures-that-touch-no-database-and-a-topshot-outage-throttles-four-collections.md)
- [🚨 **CI & testing audit — the GATES are strong, the DETECTORS are not firing**](2026-08-29T1741Z-ci-testing-audit-the-gates-are-strong-the-detectors-are-not-firing.md)
- [⭐ **`searchTopShotMarketplaceHistory` EXISTS — and a June decision deferred it on a premise that died yesterday**](2026-08-29T1810Z-the-studio-endpoint-has-searchTopShotMarketplaceHistory-and-a-june-decision-deferred-it-on-a-now-dead-premise.md)
- [🚨 **`migration-parity` is RED on 11 files right now — and the queued anon-TRUNCATE revoke would close almost nothing**](2026-08-29T1800Z-migration-parity-is-red-on-11-and-the-queued-anon-truncate-revoke-closes-almost-nothing.md)
- [⛔ **CORRECTION — it is NOT a “Top Shot outage”, and five pipelines report `ok: true` straight through it**](2026-08-29T1630Z-CORRECTION-it-is-not-a-topshot-outage-and-five-pipelines-report-ok-through-it.md)
- [🚨 **`/insights/deals` says “Updated 9 minutes ago” over Top Shot asks last verified 23 HOURS ago** — the MV-freshness fix stopped one layer short](2026-08-29T1605Z-the-deals-board-stamps-mv-refresh-time-over-asks-verified-23-hours-ago.md)
- [⛔ **10 s is NOT enough, and the query cut did not change that** — the measurement `20260828225925` explicitly asked for, taken](2026-08-29T1545Z-reconcile-10s-deadline-measured-not-enough.md)
- [🚨 **The platform's largest single addressable IO waste is blocked behind R21's CREDENTIAL ROTATION** — and nobody had drawn the line](2026-08-29T1359Z-the-platforms-largest-IO-waste-is-blocked-behind-R21s-credential-rotation.md)
- [⭐ `duration_ms` vs `extra.elapsed_ms` is a **fleet-wide contamination detector** nobody was running](2026-08-29T1353Z-duration_ms-vs-elapsed_ms-is-a-fleet-wide-contamination-detector-nobody-was-running.md)
- [⭐ `promote_unmapped_sales` re-scans **~37,000 AllDay rows every 4.6 minutes to promote ~1.5 sales an hour** — about four hours of DB time a day](2026-08-29T1341Z-promote_unmapped_sales-rescans-37k-permanently-ineligible-allday-rows-every-4.6-minutes.md)

## 2026-08-28 — 15 filings

- [⭐ **`candy_treasury_wallet` costs 21,698 buffers / 42.8 s per render** — and it is the ENTIRE residual of tonight's candy-board fix](2026-08-29T0432Z-candy_treasury_wallet-costs-21698-buffers-per-render-and-is-the-whole-residual.md)
- [⛔ **jobid 211's "three slots that have never worked" ran 41–53% ok over the full population** — the decay is **100 → 86 → 57 → 19 → 0 → 7%** over six weeks and deleting them burns the thermometer](2026-08-29T0425Z-jobid-211s-three-dead-slots-are-a-six-week-saturation-decay-and-deleting-them-burns-the-thermometer.md)
- [⛔ **"Do NOT materialise the underpriced board" reverses #39 on a RANGE-RESTRICTED null** — the two intervals that got near-zero reads ran **122 ms under MEDIAN load**](2026-08-29T0420Z-the-underpriced-board-reads-null-is-range-restricted-and-39s-escalation-still-stands.md)
- [`rpc-refresh-thin-fmv-guard` failed its 08-28 08:30Z daily tick on a statement timeout — likely band-tail saturation collateral, but unfiled and it writes an FMV table](2026-08-29T0308Z-thin-fmv-guard-daily-statement-timeout-at-0830Z-band-tail.md)
- [`pack_rips` insert rate MEASURED at **~1,200/day**: copying `2000 / 0.01` fires every **32 days**, not weekly — and setting the class in one batch fires **nine vacuums at once**](2026-08-29T0241Z-pack-rips-insert-rate-measured-copying-2000-001-fires-every-32-days-and-the-class-fires-nine-vacuums-at-once.md)
- [⭐ **My own falsifier fired** — after the build fix, the drift drain still reads **~1.8M `wallet_moments_cache` rows per pass to serve 26 wallets**](2026-08-29T0237Z-my-own-falsifier-fired-the-drift-drain-reads-1.8M-wmc-rows-a-run-to-serve-26-wallets.md)
- [⛔ **REFUTED** — the `wallet_moments_cache` lock contention is NOT the backfill wave, and **my own retry fix is still unexercised**](2026-08-29T0158Z-the-wmc-lock-contention-is-NOT-the-backfill-wave-and-my-retry-fix-is-still-unexercised.md)
- [🚨 **`detect_stalled_pipelines()` reported ALL CLEAR through a 7-hour total outage** — it measures whether the cron FIRED, not whether it WORKED](2026-08-29T0130Z-detect-stalled-pipelines-is-blind-to-a-pipeline-that-RUNS-and-FAILS.md)
- [The advisor's **289 unused indexes** is unactionable as stated — ranked by the RIGHT cost model it is a shortlist of ~6, and **HOT updates reorder it**](2026-08-29T0015Z-the-289-unused-indexes-ranked-by-the-RIGHT-cost-model-and-HOT-reorders-it.md)
- [⭐ **NEGATIVE RESULT — the "server-seeded prop has no provenance" class is 33/35 COVERED**, and the one residual is LOW severity](2026-08-29T0000Z-the-server-seeded-prop-class-is-33-of-35-COVERED-and-the-one-residual-is-low-severity.md)
- [`wallet-username-resolver` rebuilds a **21-day, ~118k-row** candidate universe every 3 h to find **0–11** wallets, and dies at its own **60 s** ceiling on 57% of ticks](2026-08-28T2350Z-wallet-username-resolver-scans-21-days-of-sales-every-3h-to-find-zero-wallets.md)
- [The ">120 s declared timeout" class has an **ACTIONABLE subset — 11 pipelines, 116 opaque errors in 7 d** — and `get_lock_check_batch` is a natural control](2026-08-28T2335Z-the-unreachable-timeout-class-has-an-ACTIONABLE-subset-of-11-pipelines-and-a-natural-control.md)
- [⚠ **Top Shot UPSTREAM 5xx outage from ~18:00Z — do NOT diagnose any of five red pipelines as internal**](2026-08-28T2320Z-topshot-upstream-5xx-outage-from-1800Z-do-not-diagnose-as-internal.md)
- [R58 — the 13 setless Top Shot `sets` rows are **TWO classes**, and "could be honest pre-seeds" is wrong for both](2026-08-28T2320Z-R58-the-13-setless-topshot-sets-are-TWO-classes-and-only-one-is-a-duplicate.md)
- [Daytime monitor 18:10Z — `rpc_ops_snapshot()` times out on its `sentinel_fmv_confidence_rows` leg during the daytime IO band](2026-08-28T1810Z-daytime-monitor-rpc_ops_snapshot-fmv-sentinel-times-out-during-the-daytime-IO-band.md)

## 2026-08-27 — 32 filings

- [✅ SHIPPED — E5: four more `after()` routes made auditable (47 → 42), and the ratchet was counting a **correctly instrumented** route as missing](2026-08-28T0445Z-E5-four-more-heartbeats-and-the-ratchet-was-counting-a-correctly-instrumented-route-as-missing.md)
- [🚨 Wallet backfill is killed on **41.5%** of dispatches — and the **redundant GHA backstop is 4.3× worse than the primary it protects**](2026-08-28T0420Z-wallet-backfill-is-killed-on-41pct-of-dispatches-and-the-REDUNDANT-BACKSTOP-is-4x-worse-than-the-primary.md)
- [⛔ RETRACTION — my own kill-rate table **pooled across a fix**, and two of six verdicts were wrong; the instrument now lives in code](2026-08-28T0350Z-RETRACTION-my-own-kill-rate-table-pooled-across-a-fix-and-two-of-six-verdicts-were-wrong.md)
- [⚠ `candy-editions-ingest` missed its 08-27 22:10Z tick — the **first miss since the 08-22 move to the quiet slot**](2026-08-28T0310Z-candy-editions-missed-its-first-tick-at-the-new-quiet-slot.md)
- [🚨 `compute-laliga-pack-ev` has written **ZERO rows in its entire life** — three defects — and its failure was **PROTECTING the honesty canon**](2026-08-28T0330Z-compute-laliga-pack-ev-has-written-ZERO-rows-in-its-entire-life-and-its-failure-was-protecting-us.md)
- [🚨 `candy-editions-ingest` is KILLED on ~45% of nights, and every kill is invisible in **both** rollups — moved out of the peak band](2026-08-28T0305Z-candy-editions-ingest-is-killed-45pct-of-nights-and-every-kill-is-invisible-in-both-rollups.md)
- [✅ SHIPPED (DB) — the pack-pool wedge is FIXED: a tier of **8** can no longer consume a **3**-wide window](2026-08-28T0255Z-SHIPPED-the-pack-pool-wedge-is-fixed-a-tier-of-8-can-no-longer-consume-a-3-wide-window.md)
- [⚠ ADDENDUM — the liveness probe **DIES at the busy hours**, so ⛔ do NOT add a slot to measure them; and my own ranking-bias claim is **REFUTED**](2026-08-28T0245Z-ADDENDUM-the-liveness-probe-DIES-at-the-busy-hours-so-do-not-add-a-slot-and-my-ranking-claim-is-refuted.md)
- [🚨 R50's numbers are measured at the FASTEST hour — the probe samples 4 fixed slots, **42% of them at 00Z**, and latency is **5× worse at 18Z**](2026-08-28T0235Z-R50-is-measured-at-the-fastest-hour-the-probe-samples-4-slots-and-42pct-are-00Z.md)
- [🚨 `refresh_wmc_fmv_changed` — the CLEAN A/B is in, and the fast path **FAILS its own exit condition on BOTH callers**](2026-08-28T0215Z-rwfc-CLEAN-AB-the-fast-path-fails-its-own-exit-condition-on-both-callers.md)
- [✅ D30 — three production-dead components removed, and a **same-named LIVE sibling** is why they survived](2026-08-28T0230Z-D30-three-dead-components-removed-and-a-same-named-live-sibling-is-why-they-survived.md)
- [✅ E5 — two `after()` routes converted on **measured kill risk**, budget 49 → 47; and `duration_ms` is not execution time](2026-08-28T0205Z-E5-two-after-routes-converted-on-measured-kill-risk-and-duration-ms-is-not-execution-time.md)
- [✅ #41 CONFIRMED on a **three-point dose–response**, its confound ruled out — and the cadence cut bought **2.7×, not 6×**](2026-08-28T0155Z-41-CONFIRMED-on-a-three-point-dose-response-and-the-cadence-cut-bought-2.7x-not-6x.md)
- [🚨 RESOLVED — the pack-pool stall is a **WEDGE**, and the mechanism is **8 permanently-empty dists in front of a 3-wide window**](2026-08-28T0145Z-the-pack-pool-stall-is-a-WEDGE-and-the-mechanism-is-8-dists-in-front-of-a-3-wide-window.md)
- [⚠ jobid 256 — "the cheapest decision on the list" rests on **two wrong premises** and hides a CI-reddening ordering trap](2026-08-28T0130Z-jobid-256-the-cheapest-decision-rests-on-two-wrong-premises-and-hides-an-ordering-trap.md)
- [✅ CLOSED — the unbounded-`fetch()` class is down to **1**, and that one is a CHECKED exclusion](2026-08-28T0115Z-the-unbounded-fetch-class-is-CLOSED-at-1-and-the-last-one-is-a-CHECKED-exclusion.md)
- [✅ ROOT CAUSE FOUND AND FIXED — the shared comment stripper desyncs on a nested template literal, and fails BOTH ways at once](2026-08-28T0056Z-ROOT-CAUSE-FOUND-the-shared-stripper-desyncs-on-nested-template-literals-and-fails-BOTH-ways.md)
- [✅ SHIPPED — all three `*-dune` routes bounded, unbounded-fetch ratchet **21 → 11**, and the bound is DERIVED not guessed](2026-08-28T0100Z-the-three-dune-routes-are-bounded-by-a-DERIVED-deadline-and-the-ratchet-falls-21-to-11.md)
- [A saturation spell, and three pipeline symptoms inside it — 2026-08-27 17:06 PT / 00:10Z](2026-08-28T0010Z-saturation-spell-symptoms-allday-mv-refresh-and-two-stalls.md)
- [Daytime monitor candidates — 2026-08-27 ~11:08 PT / 18:08Z](2026-08-27T1808Z-daytime-monitor.md)
- [🚨 A function’s `SET statement_timeout` is **PATH-DEPENDENT** — inert on pg_cron, **load-bearing via PostgREST**](2026-08-27T1404Z-a-function-statement-timeout-is-INERT-on-pg-cron-and-BINDS-via-postgrest.md)


- [⚠ The SHARED comment stripper leaves a `//` line INTACT in one file — symptom confirmed, root cause NOT found, four hypotheses falsified](2026-08-27T0500Z-the-shared-comment-stripper-leaves-a-comment-line-intact-in-one-file.md)


- [🚨 PROVEN BY EXPERIMENT — **48 pg_cron jobs declare a `statement_timeout` that has no effect**](2026-08-27T0450Z-PROVEN-48-cron-jobs-declare-a-statement-timeout-that-does-nothing.md)


- [⭐ 22.6% of this instance's cron time is thrown away — and it is **schedule ALIGNMENT**, not a load band, not a slow job](2026-08-27T0430Z-cron-waste-is-SCHEDULE-ALIGNMENT-not-a-load-band-and-one-third-of-the-hours-carry-72pct-of-it.md)


- [Claude Code handoff — Cowork cloud session, 2026-08-26 PT](2026-08-27T0420Z-CLAUDE-CODE-HANDOFF.md)


- [⚠ The cadence cut on jobid 235 saved **~1.4 h/wk, not the 3.7 h/wk claimed** — because a `REFRESH … CONCURRENTLY` costs what CHANGED](2026-08-27T0415Z-the-cadence-cut-on-jobid-235-did-not-save-what-it-claimed-because-a-CONCURRENTLY-refresh-scales-with-the-delta.md)


- [🚨 SECOND RETRACTION, same night, same route — I refused to guess a number and then reasoned as if it were zero](2026-08-27T0405Z-SECOND-RETRACTION-refusing-to-guess-a-number-is-not-a-reason-to-assume-it-is-small.md)


- [⭐ The Sentry read scope is NOT blocked in a Cowork session — and with it the shipped quota guard checks out at **93.8% coverage**](2026-08-27T0400Z-the-sentry-read-scope-is-NOT-blocked-here-and-the-quota-guard-checks-out-at-93.8pct.md)


- [🚨 I shipped a guard a concurrent session had explicitly argued against — and the argument was circular, but I did not know it existed](2026-08-27T0340Z-i-shipped-a-guard-a-concurrent-session-had-argued-against-and-the-argument-was-circular.md)


- [🚨 RETRACTION — I fit the constant to the answer on the candy indexer, and a concurrent session had already falsified the premise](2026-08-27T0330Z-RETRACTION-i-fit-the-constant-to-the-answer-on-the-candy-indexer.md)


- [`fetch()` with no timeout is a CLASS — **115 sites**, and **29 carry the shape whose failure is INVISIBLE**](2026-08-27T0320Z-unbounded-fetch-is-a-class-29-sites-carry-the-shape-whose-failure-is-invisible.md)


- [🚨 `ufc-sales-indexer` has ONLY the flaky GHA backstop left — and the backstop delivers **16 of 48** scheduled runs a day](2026-08-27T0250Z-ufc-sales-indexer-has-only-the-flaky-gha-backstop-left-and-the-backstop-delivers-a-third-of-its-schedule.md)

## 2026-08-26 — 9 filings

- [🚨 HIGH — CANDY LISTINGS FEED DARK ~38h while the heartbeat fires (+2 lower-priority)](2026-08-26T2120Z-candy-listings-feed-dark-38h-while-heartbeat-fires.md)

- [✅ CLOSED — the `roll_pack_ask_hourly_low` deadlock WATCH did not graduate: **2 deadlocks ever, none in 8 days**](2026-08-26T1745Z-CLOSED-the-roll-pack-ask-deadlock-watch-did-not-graduate.md)

- [Sentry without paying: Vercel already covers the **server** half for free — and the residual gap is client-side](2026-08-26T1730Z-sentry-without-paying-vercel-already-covers-the-server-half.md)

- [The four change-detection-less writers, measured — and the list is really ONE, not four](2026-08-26T1650Z-the-four-unguarded-upserts-measured-and-only-one-is-pinned.md)

- [The OG honesty convention is structurally UNAVAILABLE to a supabase-backed card — and one card claims "Live" on a failed read because of it](2026-08-26T1640Z-the-og-honesty-convention-is-structurally-unavailable-to-supabase-backed-cards.md)

- [🚨 The public Underpriced-#1s board **503s**, and the query behind it is **32 ms warm / 19,895 ms cold**](2026-08-26T1630Z-the-underpriced-serials-board-503s-in-public-and-it-is-32ms-warm.md)

- [Daytime monitor — 2026-08-26 08:19 PT (first tick of day)](2026-08-26T1519Z-daytime-monitor.md)

- [🚨 Sentry is STILL dropping everything — but the 429 is gone, so the probe that "SETTLED" it now returns a clean 200](2026-08-26T1545Z-sentry-still-drops-everything-but-the-429-is-gone-so-the-probe-that-settled-it-now-reads-clean.md)

- [⭐ The `targets` RPC: #30's hypothesis is now MEASURED and CONFIRMED, three candidate fixes falsified, and the fix is one INCLUDE column](2026-08-26T1500Z-the-targets-rpc-is-50s-of-DISTINCT-ON-and-edition-fmv-current-is-NOT-a-drop-in.md)

## 2026-08-25 — 17 filings

- [🚨 SETTLED — Sentry is not broken, misconfigured or blocked: the ORG ERROR QUOTA is exhausted, and ONE already-tracked signature burned it](2026-08-26T0525Z-SETTLED-sentry-is-not-broken-the-org-error-quota-is-exhausted-and-one-signature-burned-it.md)

- [⭐ SHIPPED — the PG17-unreachable index is repaired, "only EXPLAIN settles it" is REPLACED by a decidable rule, and one judgement is RETRACTED](2026-08-26T0620Z-SHIPPED-the-pg17-index-is-repaired-and-the-shape-IS-a-decidable-rule-after-all.md)

- [⭐ SHIPPED (cadence) — two pack-sales backfills were **71.9 GB/day of disk reads and 4.55 GB/day of WAL** to add ~165 rows a day](2026-08-26T0635Z-SHIPPED-two-pack-sales-backfills-were-72GB-a-day-of-disk-reads-for-165-new-rows.md)

- [🚨 `refresh_wmc_fmv_changed` is **40% of every block this database dirties** — and its lever is a 13 MB table that already exists](2026-08-26T0645Z-refresh-wmc-fmv-changed-is-40pct-of-all-writes-and-the-lever-is-a-13MB-table-that-already-exists.md)

- [⛔ Git push from a Cowork cloud session — the credential is PRESENT AND VALID; the repo is not in the session's authorized set](2026-08-26T0650Z-git-push-is-a-repo-AUTHORIZATION-problem-the-credential-is-present-and-valid.md)

- [✅ RESOLVED by the owning session (was: SECURITY, low-harm, filed-not-fixed) — `_rpc_waste_baseline_20260825` was ANON-READABLE and is what is reddening the smoke test right now](2026-08-26T0650Z-a-scratch-baseline-table-is-anon-readable-and-is-reddening-the-smoke-test.md)

- [🚨 `atlas-proxy` will NOT un-red `topshot-active-listings-ingest` — re-verified live, and the real blocker is ONE RPC](2026-08-26T0630Z-atlas-proxy-will-not-un-red-the-listings-ingest-the-targets-rpc-is-the-blocker.md)

- [⛔ CORRECTED — the pg_cron re-stagger's exit condition passes **~33%** of the time if the fix did nothing (published 74%, WITHDRAWN) — `check_pgcron_recent_failures()` reports LATEST-RUN status, not "has this job been failing"](2026-08-26T0525Z-the-cron-reschedule-exit-condition-passes-74pct-of-the-time-if-the-fix-did-nothing.md)

- [⭐ PROMOTED 2026-08-25 — a stale `.git/index.lock` makes `git checkout --` and `git merge` SILENTLY no-op — and `merge` PRINTS `Updating X..Y` while HEAD never moves](2026-08-26T0411Z-git-gotcha-a-stale-index-lock-makes-merge-print-Updating-while-HEAD-never-moves.md)


- [🚨 `candy-listings-indexer` is NOT silent — the cron fires, the route runs, and the work is KILLED at 300 s on 73% of ticks; zero completions in 21 h](2026-08-26T0400Z-candy-listings-indexer-is-not-silent-it-is-killed-at-300s-on-73pct-of-ticks.md)


- [⭐ SHIPPED — `weekly-db-maintenance` is DAILY not weekly, and the 24h floor was marking a perfectly healthy WEEKLY job red ~6 days in 7](2026-08-26T0320Z-weekly-db-maintenance-is-daily-and-the-24h-floor-makes-a-healthy-weekly-job-permanently-red.md)


- [⛔ §2 RETRACTED — the golazos "scheduler-skip" is REFUTED (the cron fired 8/8), but the pg_net DNS mechanism I published was WRONG](2026-08-26T0210Z-the-golazos-scheduler-skip-is-refuted-22pct-of-all-pg-net-dispatches-time-out.md)

- [🚨 Sentry is dark on **DAY SEVEN** — and the monitor has been reading that silence as a clean bill of health](2026-08-26T0100Z-sentry-is-dark-on-day-seven-and-the-monitor-reads-the-silence-as-health.md)

- [Daytime monitor — saturation spell in progress at 21:10Z (SYMPTOM only)](2026-08-25T2110Z-daytime-monitor-saturation-spell-symptom.md)

- [⭐ The `nfl_all_day` promote leg is NOT dormant — it resolved a row **16 minutes** before measurement, and the SUNSET label describes the COLLECTION, not this pipeline](2026-08-25T2113Z-the-allday-promote-leg-is-not-sunset-it-resolved-a-row-16-minutes-ago.md)

- [⛔ SUPERSEDED (root cause) — `compute-golazos-pack-ev` has skipped ~2–3 scheduled ticks (cadence-silent ~17.5 h) while the pipeline is healthy every time it runs](2026-08-25T1809Z-compute-golazos-pack-ev-cadence-silent-17h-pipeline-healthy-when-it-runs.md)

- [🚨 `rpc-ccm-step2` is NOT saturation collateral — it nested-loops 220 whale wallets holding **72% of the Top Shot partition**](2026-08-25T1535Z-ccm-step2-is-not-saturation-collateral-it-nested-loops-72pct-of-wmc.md)

## 2026-08-24 — 7 filings

- [🚨 All three Flowty listing caches hold EXACTLY 100 rows, because `offset` does not paginate — at least 5,000 are obtainable in ONE request](2026-08-25T0620Z-every-flowty-listing-cache-holds-exactly-100-rows-because-offset-does-not-paginate.md)

- [`topshot-pack-pool-backfill`'s last error shifted from the ledger's documented 403 to a 200-level "no editions"](2026-08-25T0312Z-pack-pool-backfill-error-shifted-from-403-to-a-200-level-no-editions.md)

- [`cross_collection_ts_set_overlap_mat` is ~51h stale and NO standing instrument watches it](2026-08-25T0011Z-cross-collection-overlap-mat-is-51h-stale-and-no-standing-metric-watches-it.md)

- [⭐ SHIPPED — nothing ever checked whether a materialized view is anon-readable, and every new one is born that way](2026-08-24T2345Z-nothing-ever-checked-whether-a-materialized-view-is-anon-readable.md)
- [There are TWO client `Sentry.init()` calls, and which one wins depends on the BUNDLER — under production's turbopack the richer config is INERT](2026-08-24T1510Z-there-are-two-client-sentry-inits-and-which-one-wins-depends-on-the-bundler.md)
- [`allday-pack-opens-backfill` `cron_silent` watchlist arm is now a FALSE POSITIVE — the finite walk finished and the arm cannot tell "done" from "scheduler stopped"](2026-08-24T1507Z-allday-pack-opens-cron-silent-arm-is-a-false-positive-now-the-finite-walk-is-done.md)
- [A COLD ISR regeneration can exceed the 8 s board budget and bake the failure into 15 minutes of cached HTML — and `pack-drops` has no stale snapshot](2026-08-24T1441Z-a-cold-isr-regeneration-can-bake-a-failed-read-into-15-minutes-of-cached-html.md)

## 2026-08-23 — 23 filings

- [⛔ The FMV haircut's Top Shot leg is **800,545 buffers / 101 s to find 14 rows** — and the obvious `edition_fmv_current` fix **silently loses 71% of them**](2026-08-24T0455Z-the-fmv-haircut-topshot-leg-costs-800k-buffers-and-the-obvious-fix-loses-71pct-of-it.md)
- [🔴 `topshot-active-listings-ingest` is 100% red for 5+ days, and the documented cause is 22% of it](2026-08-24T0430Z-topshot-active-listings-ingest-is-100pct-red-and-the-documented-cause-is-22pct-of-it.md)
- [⛔ The largest job on the instance writes NO telemetry — and a second, cheaper caller wears its name in `pipeline_runs`](2026-08-24T0400Z-the-biggest-job-on-the-instance-has-no-telemetry-and-another-caller-wears-its-name.md)
- [⭐ SHIPPED — the UFC and Golazos promote legs are parked, using the function's own recheck mechanism rather than a new gate](2026-08-24T0345Z-ufc-and-golazos-promote-legs-parked-using-the-functions-own-mechanism.md)
- [⛔ The public-board watchdog discards ALL completed probes when any single board times out — and a "succeeded" tick covered 6 of 45](2026-08-24T0225Z-the-board-watchdog-loses-every-probe-it-completed-when-any-one-times-out.md)
- [The read path ATTRIBUTED — 15 RPCs are 93 h of DB time in 11 d, and 0.9% of the calls are 14.6% of it; plus `apply-fmv-haircut` is NOT an FMV-staleness incident and `sync-nba-projections` is off-season](2026-08-23T2235Z-the-read-path-attributed-and-two-severity-corrections.md)
- [⭐ SHIPPED — one leading-wildcard `LIKE` was seq-scanning 88,086 rows 4,684 times per refresh, and it cost 13,000 worker-seconds a day](2026-08-23T2210Z-one-leading-wildcard-LIKE-was-costing-13000-worker-seconds-a-day.md)
- [🚨 ~1,000 editions are labelled LOW confidence while their own row records them as the MOST-traded on the platform — in every collection the LOW cohort trades ~2× the MEDIUM cohort](2026-08-24T0225Z-a-thousand-editions-are-labelled-LOW-while-they-are-the-most-traded-on-the-platform.md)
- [⭐ PRIORITY 1 CAPTURED, first time since 2026-07-26: signed-in WAU is 0, and the accuracy gate stands at 30.1% HIGH/MEDIUM — with three denominator caveats](2026-08-23T2205Z-priority-1-captured-wau-is-zero-and-the-accuracy-gate-is-30-percent.md)
- [⭐ The series-rollup fix WAS load-tested — its best run happened in the day’s worst hour, and I spent all evening saying it was unverified](2026-08-23T2055Z-the-series-rollup-fix-was-already-load-tested-i-just-never-read-the-neighbours.md)
- [Daytime monitor — the saturation spell DEEPENED since 18:10Z and `apply-fmv-haircut` missed a full daily cycle](2026-08-23T2110Z-daytime-monitor-spell-deepened-and-apply-fmv-haircut-missed-a-full-daily-cycle.md)
- [SIXTEEN more migrations applied today still have no committed file — a SECOND batch, after this morning's recovery](2026-08-23T2030Z-sixteen-more-migrations-applied-today-still-have-no-committed-file.md)
- [Postgres 17 makes a partial index UNREACHABLE when its predicate says `col IS NOT NULL` and the column is declared NOT NULL — including the 98 MB index `fmv-recalc` needs](2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md)
- [`fmv-recalc` is NOT wedged mid-catalogue — page 0 can no longer COMPLETE, and the trust board has been breaching for 20 h unread](2026-08-23T2000Z-fmv-recalc-is-not-wedged-mid-catalogue-page-0-can-no-longer-complete.md)
- [Sentry went dark at a precise minute, and the burst before it is the defect fixed today](2026-08-23T1930Z-sentry-went-dark-at-a-precise-minute-and-the-burst-before-it-is-the-defect-fixed-today.md)
- [`promote_unmapped_sales` burns 1,598 s/week on two collections that promote ZERO rows — visible only now that duration_ms works](2026-08-23T1930Z-promote-unmapped-sales-burns-1598s-a-week-on-two-collections-that-promote-nothing.md)
- [The index built for fmv-recalc has never been used in 72 days, and is bigger than the one that beats it](2026-08-23T1910Z-the-index-built-for-fmv-recalc-has-never-been-used-and-is-bigger-than-the-one-that-beats-it.md)
- [⭐ `pipeline_runs.duration_ms` was structurally 0 for TEN pipelines — fixing one word exposed a 37.8s job and a 78.4s job that had always reported 0](2026-08-23T1910Z-pipeline-runs-duration-ms-was-structurally-zero-for-ten-pipelines.md)
- [`get_team_detail` is the same defect family, but the expensive half is 30d SALES not FMV — and it needs a rollup, not a rewrite (measured, NOT shipped)](2026-08-23T1850Z-team-detail-is-the-same-defect-family-and-the-sales-half-needs-a-rollup-not-a-rewrite.md)
- [Daytime monitor — saturation spell ACTIVE at ~18:10Z; everything measured in that window is a SYMPTOM, re-measure quiet](2026-08-23T1812Z-daytime-monitor-saturation-spell-symptoms.md)
- [R6 re-measured in-band: 1 of 5 not 4 of 5, and the expensive lateral runs TWICE per request](2026-08-23T1805Z-r6-re-measured-in-band-one-of-five-not-four-and-the-lateral-runs-twice.md)
- [The allday-pack-opens-backfill mechanism is REFUTED and the proposed fix would lose data](2026-08-23T1609Z-the-pack-opens-backfill-mechanism-is-refuted-and-the-proposed-fix-would-lose-data.md)
- [R46 is a working-set problem not an IOPS one and the first lever may be free](2026-08-23T1610Z-R46-is-a-working-set-problem-not-an-IOPS-one-and-the-first-lever-may-be-free.md)
## 2026-08-22 — 35 filings

- [The pack simulator's flip animation keeps calling `setState` after unmount — an intermittent unhandled rejection that fails `npm test` while every test passes](2026-08-23T0555Z-the-pack-simulator-flip-loop-keeps-setting-state-after-unmount.md)
- [R21 re-derived: 67 / 38 / 29 reproduces exactly — but its named example LEFT the set, and nobody had enumerated it](2026-08-23T0555Z-r21-re-derived-the-count-held-and-the-set-did-not.md)
- [`check_public_security_invariants()` is RED for the first time since it was written — on a table whose grants are correct](2026-08-23T0510Z-the-rls-invariant-check-is-red-on-a-table-that-is-correctly-locked.md)
- [HIGH-PRIORITY — `reconcile_all_saved_wallet_stats` broken by today's R14 `ALTER PROCEDURE … SET search_path` (a SET-clause procedure cannot COMMIT)](2026-08-23T0311Z-reconcile-saved-wallet-stats-broken-by-set-clause-on-committing-procedure.md)
- [`public_board_slow_count` / `public_board_empty_count` write their "could not measure" sentinel at 21 of their last 36 slots — the standing breach is partly an unmeasured arm, not 45 unhealthy boards](2026-08-23T0255Z-the-board-liveness-arms-read-their-999-cannot-measure-sentinel-at-21-of-36-slots.md)
- [🚨 Sentry has ingested NOTHING since 2026-08-18 13:21:59Z — and Vercel logged the *identical* error string 447 times in the last 24 hours](2026-08-23T0250Z-sentry-has-received-nothing-since-08-18-while-production-throws-the-same-error-hundreds-of-times-a-day.md)
- [The `.range()` guard states the uniqueness rule in its own header and asserts something weaker — a repo-wide measurement of what it cannot see](2026-08-23T0236Z-the-paginated-range-guard-states-the-uniqueness-rule-in-a-comment-and-cannot-check-it.md)
- [`/sitemap/3.xml` truncates on a statement timeout and returns the partial set as if it were complete — and it pages on a key where 72% of rows are ties](2026-08-23T0228Z-the-sitemap-truncates-on-a-statement-timeout-and-pages-on-a-key-that-is-72pct-ties.md)
- [Pinnacle bulk ONE-WAY transfers are a real, untracked ownership change](2026-08-22T2030Z-pinnacle-bulk-one-way-transfers-are-untracked.md)

- [RESOLVED, SHIPPED, and carrying three of my own corrections: Golazos Series 2/3 never existed on chain (nextSeriesID=2) and the rows are deleted; the series route was 500ing on every collection because a rollup that ALREADY EXISTED had no reader — now 26/26 URLs return 200](2026-08-23T0210Z-golazos-series-2-and-3-never-existed-and-the-whole-series-route-is-dead.md)

- [/api/ready has been 500ing for eight days, and it settles a disagreement](2026-08-23T0025Z-api-ready-has-been-500ing-for-eight-days-and-it-settles-a-disagreement.md)

- [pg_cron reports 141/144 successes while allday-pack-opens-backfill has written nothing for 12.6h](2026-08-23T0200Z-allday-pack-opens-backfill-silent-while-pg-cron-reports-141-successes.md)

- [`collection_series` claims LaLiga Golazos has Series 2 and Series 3 — no instrument we own can see a single moment from either, and the series filter offers both](2026-08-23T0020Z-golazos-collection-series-claims-two-seasons-that-no-instrument-can-see.md)
- [The production bundle rendered a user-facing sentence that the committed source does not contain — a `+`-joined template literal lost the tail of its first chunk](2026-08-22T2135Z-production-bundle-dropped-a-string-segment-the-source-contained.md)
- [20 guards share a copy-pasted `stripComments` that hides 109,123 characters of real source — a `//` comment containing `/*` swallows every line until the next `*/`](2026-08-22T2105Z-stripcomments-hides-109k-chars-of-real-source-from-20-guards.md)
- [The cross-collection board hardcodes "143 wallets" in its SEO description and in the text users share — the true count is 221](2026-08-22T2050Z-cross-collection-board-hardcodes-143-wallets-in-seo-and-share-text.md)
- [The saturation is structural, not a spell — a measured waste ledger](2026-08-22T1956Z-the-saturation-is-structural-a-waste-ledger-from-pg-stat-statements.md)
- [The unbounded-server-read class bit a FOURTH time — and 23 more instances sit outside the guard written to stop it](2026-08-22T1929Z-23-unbounded-server-reads-live-outside-the-guard-that-exists-for-them.md)
- [Five public pages exceeded 30s to `domcontentloaded` in the 13:15Z e2e run — and the same pages were clean at 07:16Z and 18:58Z](2026-08-22T1905Z-five-public-pages-exceeded-30s-to-domcontentloaded-inside-the-degraded-band.md)
- [The zero-denominator percentage family: two gate meters fixed, three write-sites filed rather than changed](2026-08-22T1850Z-zero-denominator-percentages-two-gate-meters-fixed-three-write-sites-filed.md)
- [86 distinct mobile controls are under the 44px tap-target floor — a DESIGN decision, not a bug list](2026-08-22T1836Z-86-mobile-tap-targets-under-44px-and-the-instrument-that-found-them.md)
- [The roadmap's #1 metric is unreadable ~20 hours a day, and the cause is structural — but my candidate fix did NOT validate](2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-and-the-cause-is-structural.md)
- [🚨 P0 — the 2026-08-03 credential purge was DEFEATED: the purged blob is still reachable on a stale branch of the PUBLIC repo](2026-08-22T1620Z-P0-the-08-03-credential-purge-was-defeated-by-a-stale-public-branch.md)
- [The pg_cron `job startup timeout` class finally has a named cause — and a near-miss that would have frozen a stale MV permanently](2026-08-22T1600Z-the-startup-timeout-class-has-a-named-cause-and-a-near-miss-that-would-have-frozen-an-mv.md)
- [`candy-editions-ingest` — the 08-04 timeout fix SHIPPED and it is silent again for the same reason at a higher ceiling](2026-08-22T1600Z-candy-editions-is-band-killed-not-timeout-fixed.md)
- [`pinnacle-sync` was a FALSE stall — the arm watched a self-report while the outcome had no arm at all. Plus: the hydrator's schedule is declared nowhere in the repo](2026-08-22T1545Z-pinnacle-sync-was-a-false-stall-and-the-hydrator-schedule-is-in-no-repo-file.md)
- [Daytime monitor — 2026-08-22T1509Z (~08:06 PT, first-tick-of-day)](2026-08-22T1509Z-daytime-monitor.md)
- [One of the four never-run walkers is a DUPLICATE of a live pipeline, not a gap — and that halves the decision](2026-08-22T1500Z-one-of-the-four-never-run-walkers-duplicates-a-live-pipeline.md)
- [Two dropped checks, executed: the concierge probe PASSES, and NBA projections has been dark for 18 days on zero arms](2026-08-22T1450Z-nba-projections-18-dark-days-and-the-concierge-probe-check-nobody-ran.md)
- [The disk-IO budget, ranked: 7,809 GB / 242h, and the two priciest boards are LIVE (I nearly filed the opposite)](2026-08-22T0340Z-the-disk-io-budget-ranked-and-three-switches-that-mean-live.md)
- [Ask-corroboration is Top-Shot-only BY DESIGN — and extending it to All Day is worth 320 editions (+5.2pp on that collection, +1.1pp on the gate)](2026-08-22T0320Z-ask-corroboration-is-top-shot-only-BY-DESIGN-and-it-is-worth-320-allday-editions.md)
- [The accuracy gate, measured: 31.3% at HIGH/MEDIUM — and it tracks LIQUIDITY, not the pricing algorithm](2026-08-22T0256Z-the-accuracy-gate-measured-31pct-and-it-tracks-liquidity-not-the-algorithm.md)
- [`reconcile-saved-wallet-stats`'s "is the sweep keeping up?" metric measures a population the sweep excludes by construction — and it misled me today](2026-08-22T0130Z-oldest-cache-h-measures-a-population-the-sweep-excludes-by-construction.md)
- [`refresh_wmc_fmv_changed`'s temp-table build costs 120× what it needs to — and my own "permanently backlogged" reading of that function is WITHDRAWN](2026-08-22T0010Z-refresh-wmc-fmv-changed-temp-build-is-120x-its-necessary-cost-and-my-backlog-reading-is-withdrawn.md)
- [Daytime monitor — 2026-08-22T00:06Z (2026-08-21 17:06 PT)](2026-08-22T0006Z-daytime-monitor.md)

## 2026-08-21 — 16 filings

- [ESCALATION — the cross-collection mats have failed EVERY daily run since 08-18, the board is 4d19h stale, and the 08-18 filing's own escalation trigger fired three days ago](2026-08-21T2340Z-ESCALATION-the-cross-collection-mats-have-failed-every-day-since-08-18.md)
- [The `deals` board is a VICTIM of a global 20h/day slowdown, not its cause — and the same window costs FMV recalc ~19 hours a day](2026-08-21T2315Z-the-deals-board-is-a-victim-and-fmv-recalc-loses-19-hours-a-day.md)
- [The flagship `deals` board fails ~80% of refreshes, is up to 15.1h stale, and the failure is ~20h/day — not the 05–08:30Z saturation window](2026-08-21T2245Z-the-deals-board-fails-80pct-of-refreshes-and-is-20h-a-day-not-a-saturation-window.md)
- [Daytime monitor — 2026-08-21T21:05Z (14:05 PT)](2026-08-21T2105Z-daytime-monitor.md)
- [259 reads in `app/api/**` never destructure `error` — and two existing honesty guards exclude that tree on a premise that is false](2026-08-21T1945Z-259-route-reads-never-look-at-their-error-and-two-guards-exclude-app-api-on-a-false-premise.md)
- [`allday-pack-opens-backfill` throughput collapsed ~1,000× on 2026-08-11 — ETA to floor is now ~12 years](2026-08-21T1735Z-allday-pack-opens-backfill-throughput-collapsed-1000x.md)
- [Vercel's runtime-error ROUTE attribution is smeared — the homepage is not failing on a Panini board](2026-08-21T1730Z-vercel-runtime-error-route-attribution-is-smeared.md)
- [Four of the nineteen hardened event-range walkers have never run](2026-08-21T1701Z-four-of-the-nineteen-hardened-walkers-have-never-run.md)
- [Daytime monitor — 2026-08-21T15:05Z (≈08:05 PT, first tick of day)](2026-08-21T1505Z-daytime-monitor.md)
- [An upstream HTTP error defeats the cursor hold in 7 of 8 block-scan indexers](2026-08-21T1420Z-an-http-error-defeats-the-cursor-hold-in-7-of-8-indexers.md)
- [Two wrangler configs deployed to ONE Cloudflare worker, and the fossil would have silently downgraded the live one](2026-08-21T0510Z-two-wrangler-configs-deployed-to-one-worker-and-the-fossil-would-have-downgraded-it.md)
- [Two findings from the coverage pass's tail — 2026-08-20 (PT)](2026-08-21T0400Z-two-findings-from-the-coverage-pass-tail.md)
- [Daytime monitor — 2026-08-21T03:09Z (≈20:09 PT, 08-20 evening)](2026-08-21T0309Z-daytime-monitor.md)
- [Area (7)'s render-layer gap is already closed — 30 of 31 server pages discriminate, and a source guard would red on correct code](2026-08-21T0245Z-area-7s-render-layer-gap-is-already-closed-and-a-source-guard-would-red-on-correct-code.md)
- [The five-source caller rule is blind to `pg_trigger` — 33 live functions read as dead, and area (5)'s headline item is a false positive](2026-08-21T0140Z-the-caller-rule-is-blind-to-triggers-and-item-5s-headline-is-a-false-positive.md)
- [Three anon-public tabs declare a canonical pointing at a URL that 302s Googlebot to /login](2026-08-21T0030Z-three-anon-public-tabs-canonicalise-to-a-login-wall.md)

## 2026-08-20 — 4 filings

- [Test-coverage analysis — 2026-08-20 (PT)](2026-08-20T2325Z-test-coverage-analysis.md)
- [Daytime monitor — 2026-08-20T21:08Z (≈14:08 PT)](2026-08-20T2108Z-daytime-monitor.md)
- [Daytime monitor — 2026-08-20T03:06Z (≈20:06 PT)](2026-08-20T0306Z-daytime-monitor.md)
- [Daytime monitor — 2026-08-20T00:12Z (≈17:12 PT)](2026-08-20T0012Z-daytime-monitor.md)

## 2026-08-19 — 3 filings

- [Daytime-peak saturation spell — SYMPTOM filing (do not act causally)](2026-08-19T2107Z-daytime-peak-saturation-spell-symptom.md)
- [Daytime monitor — 2026-08-19T15:11Z (≈08:11 PT, first tick)](2026-08-19T1511Z-daytime-monitor.md)
- [Daytime monitor — 2026-08-19T00:06Z (2026-08-18 ~17:06 PT)](2026-08-19T0006Z-daytime-monitor.md)

## 2026-08-18 — 29 filings

- [Daytime monitor — 2026-08-18T21:10Z (in an active saturation spell)](2026-08-18T2110Z-daytime-monitor.md)
- [UFC dormancy: every DB-side instrument agrees, one apparent counter-signal is REFUTED, and the decisive test is still operator-only](2026-08-18T2100Z-ufc-dormancy-is-consistent-but-the-decisive-test-is-still-operator-only.md)
- [⛔ RETRACTION — Top Shot is NOT losing ground. I read a burst as a trend, from two points.](2026-08-18T2100Z-RETRACTION-top-shot-is-not-losing-ground-i-read-a-burst-as-a-trend.md)
- [The rotation works — and Top Shot is still losing ground. The one unverified inference is refuted.](2026-08-18T1930Z-the-rotation-works-and-top-shot-is-still-losing-ground.md)
- [The wmc backfill converts again (0 → 1,000 a tick), and the cross-collection mat timeout was saturation, not growth](2026-08-18T1835Z-the-wmc-backfill-starvation-is-fixed-by-scoping-and-the-ccm-timeout-was-saturation.md)
- [52% of `net._http_response` is one HEALTHY pipeline abandoning its own replies at the 5000 ms default](2026-08-18T1835Z-half-of-net-http-response-is-one-healthy-pipeline-at-the-5000ms-default.md)
- [Six of the eight "de-hardcoded" gate functions never had that code deployed — their secrets are inert](2026-08-18T1830Z-six-de-hardcoded-gate-fns-never-had-that-code-deployed-BLOCKER.md)
- [Candidate — `rpc-roll-pack-ask-hourly-low` shows a `deadlock detected` signature (SYMPTOM, observed in a spell)](2026-08-18T1808Z-roll-pack-ask-hourly-low-deadlock-signature-during-a-saturation-spell-SYMPTOM.md)
- [`idx_wmc_fmv_conf_null` is BUILT — and the route that built it overturns a recorded "impossible". The backfill is still converting ~0 rows, for a different reason.](2026-08-18T1725Z-wmc-fmv-conf-index-SHIPPED-via-pg_cron-and-the-backfill-is-starved-by-a-pinnacle-head-block.md)
- [The four-source caller rule is blind to Cowork artifacts — 8 live objects read as dead](2026-08-18T1620Z-the-four-source-caller-rule-is-blind-to-cowork-artifacts.md)
- [`idx_wmc_fmv_conf_null` — finding VERIFIED, fix READY, build BLOCKED on an idle window (and it left an INVALID index you must drop first)](2026-08-18T1545Z-wmc-fmv-confidence-index-verified-and-ready-but-BLOCKED-on-an-idle-window.md)
- [`get_fmv_coverage()` plans the SAME correlated `EXISTS` twice — and it took the whole data-integrity monitor down](2026-08-18T1510Z-get-fmv-coverage-plans-the-same-exists-twice.md)
- [Daytime monitor — 2026-08-18 ~08:06 PT (15:06Z) · FIRST-TICK-OF-DAY](2026-08-18T1506Z.md)
- [pack-EV / `fmv_current`: the LATERAL fix is verified equivalent — and the fixture-preserving alternative is refuted](2026-08-18T1410Z-pack-ev-lateral-verified-and-the-array-pushdown-does-not-transfer.md)
- [`compute-golazos-pack-ev` is SETTLED: not cron, not retention, NOT saturation — and the freshness arm reads green through it](2026-08-18T1406Z-golazos-pack-ev-is-not-saturation-and-the-freshness-arm-cannot-see-it.md)
- [`drain-fmv-cold-tail`: the caller is healthy — the `after()` work is killed at `maxDuration`, and has been since June](2026-08-18T1400Z-drain-fmv-cold-tail-is-killed-by-maxduration-not-its-caller.md)
- [`drain-fmv-cold-tail` has STOPPED — and the other "genuine miss" was a false positive](2026-08-18T0515Z-drain-fmv-cold-tail-has-stopped-and-resolve-topshot-stubs-was-a-false-positive.md)
- [Blast radius of the watchlist derivation: 67 added → 4 breaching, 0 chronic — but only under a rule the rows do not use](2026-08-18T0455Z-watchlist-derivation-blast-radius-measured.md)
- [Watchlist coverage was measured against rows the monitor ignores — the blind spot is 67, not 62](2026-08-18T0450Z-watchlist-coverage-was-measured-against-rows-the-monitor-ignores.md)
- [Candidate — the durable fix for jobid 218: make the `LIMIT` bind. Plans + cardinalities MEASURED; the timing A/B is NOT](2026-08-18T0425Z-the-durable-fix-for-jobid-218-make-the-limit-bind-plans-measured-timing-not.md)
- [Candidate — systemic hourly heavy-cron pileup in the :13–:34 band is manufacturing IO-saturation spells](2026-08-18T0330Z-heavy-cron-collision-pinnacle-backfill-io.md)
- [Test-coverage analysis — where the remaining risk actually is (2026-08-18 02:30Z / 2026-08-17 19:30 PT)](2026-08-18T0230Z-test-coverage-analysis.md)
- [Answering the open question on #8: restoring ESPN alone will NOT refill `nba_players` — the roster fetch is SLATE-GATED, and the season is over](2026-08-18T0120Z-restoring-espn-alone-will-not-refill-nba_players-the-roster-fetch-is-slate-gated.md)
- [The Pinnacle null-edition pool IS the catalog-coverage gap — and parking those rows would hide a hole that is still widening](2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-and-parking-it-would-hide-a-widening-hole.md)
- [The board-liveness SWEEP completes only ~half the time — and `cron.job_run_details.status` under-reports that by 40%](2026-08-18T0105Z-the-board-liveness-sweep-completes-only-half-the-time-and-cron-status-under-reports-it.md)
- [The sports-proxy 403 is TWO different causes needing TWO different fixes — the "three providers tightening bot-blocking" framing is refuted](2026-08-18T0100Z-the-sports-proxy-403-is-TWO-causes-not-one.md)
- [`topshot-misattrib-drain` resolves fine but has NOT applied a re-key since 2026-08-07 — and my first severity read was 6.5x too high](2026-08-18T0050Z-misattrib-drain-resolves-but-has-not-applied-a-rekey-since-08-07.md)
- [Top Shot series 6/7/8 carry TWO different display labels, and both are user-visible](2026-08-18T0045Z-top-shot-series-6-7-8-have-two-different-display-labels-and-both-are-user-visible.md)
- [Daytime monitor: `compute-golazos-pack-ev` silent 17.5h + `get_team_players` 45s timeout on team pages](2026-08-18T0013Z-golazos-pack-ev-silent-17h-and-team-roster-rpc-timeout.md)

## 2026-08-17 — 21 filings

- [The 2026-08-15 conflated-subedition reorder FIXED the drain — and its `ok` flag makes the recovery invisible](2026-08-17T2345Z-the-conflated-subedition-drain-fix-WORKED-and-its-ok-flag-hides-it.md)
- [Watchlist coverage audit: 62 of 149 active pipelines are unwatched, 5 of them have zero successes — and a curated list is why](2026-08-17T2320Z-watchlist-coverage-audit-62-of-149-pipelines-are-unwatched.md)
- [`panini_sale_field_mapping_shortfall` is mathematically incapable of firing while `panini_sale_price_capture_dry_days` is breached — and its own comment says it "Reads 0" when it reads −19](2026-08-17T2245Z-the-panini-mapping-shortfall-arm-cannot-fire-while-its-sibling-is-breached.md)
- [UFC Strike has recorded ZERO sales for 96 days, and `ufc-sales-indexer` reports 112/113 ok while writing 0 rows](2026-08-17T2210Z-ufc-strike-has-had-zero-sales-for-96-days-and-the-indexer-reports-ok.md)
- [Daytime monitor — 2026-08-17T21:06Z (14:06 PT, afternoon tick)](2026-08-17T2106Z-daytime-monitor.md)
- [The sports-proxy 403 is NOT a secret problem — it is three upstreams 403'ing across TWO independent egress networks](2026-08-17T1845Z-the-sports-proxy-403-is-not-a-secret-it-is-three-upstreams-across-two-egress-networks.md)
- [Daytime monitor — 2026-08-17T18:06Z (11:06 PT, later tick)](2026-08-17T1806Z-daytime-monitor.md)
- [`raise_impossible_parallel_circ` is NOT waste — it is real data-integrity healing running at 28× the cadence its work arrives at](2026-08-17T1712Z-the-impossible-parallel-selfheal-is-not-waste-it-is-28x-over-cadenced.md)
- [`topshot-wmc-fossil-drain` times out proving emptiness — and it is on no watchlist, so neither arm sees it](2026-08-17T1656Z-the-fossil-drain-times-out-proving-emptiness-and-nothing-watches-it.md)
- [Daytime monitor — 2026-08-17T15:18Z (08:18 PT, first tick of day)](2026-08-17T1518Z-daytime-monitor.md)
- [The saturation self-throttle fails OPEN on a returned error — 9 routes, and it fails open exactly when it is needed](2026-08-17T1211Z-the-saturation-self-throttle-fails-OPEN-on-a-returned-error-in-9-routes.md)
- [`fmv-recalc` re-breached ~4 h after being marked CLOSED, and current saturation does not explain it](2026-08-17T0450Z-fmv-sweep-re-breached-4h-after-being-marked-CLOSED-and-saturation-does-not-explain-it.md)
- [`wallet-username-resolver` dies in its CANDIDATE SELECTION — and chasing why exposed an untested half of this repo's `statement_timeout` rule](2026-08-17T0440Z-wallet-username-resolver-dies-in-its-candidate-selection-and-the-proconfig-rule-has-an-untested-half.md)
- [The pg_cron startup timeout is NOT a worker-slot cap — it is the saturation, and the obvious config fix does nothing](2026-08-17T0410Z-the-pgcron-startup-timeout-is-not-a-worker-slot-cap-it-is-the-saturation.md)
- [Pipeline restoration sweep — 2 restored, 3 blocked on access I don't have, and the monitoring gap that let all of it run for days](2026-08-17T0320Z-pipeline-restoration-sweep-what-is-fixed-what-is-blocked-and-the-monitoring-gap.md)
- [Daytime monitor — 2026-08-17 03:10Z (20:10 PT Aug 16)](2026-08-17T0310Z-daytime-monitor.md)
- [⛔ REFUTED TWICE, ROOT CAUSE FOUND: pack-EV is slow because `fmv_current` never pushes down — not because the 12 h target is unaffordable](2026-08-17T0225Z-backfill-historical-pack-ev-chases-a-12h-target-it-can-never-hit.md)
- [`match-topshot-players` — failing every daily run since 08-14, and its declared 300 s budget is INERT](2026-08-17T0200Z-match-topshot-players-has-failed-every-run-since-08-14-and-its-300s-budget-is-inert.md)
- [`allday-unmapped-resolver-tail` — NOT broken; it is grinding an exhausted backlog at ~52 min / 3 days for 5 rows](2026-08-17T0130Z-the-allday-tail-resolver-is-not-broken-it-is-grinding-an-exhausted-backlog.md)
- [`candy-editions-ingest` — the runtime is unbounded on fixed work, and the maxDuration lever is exhausted](2026-08-17T0030Z-candy-editions-runtime-is-unbounded-and-the-clock-lever-is-exhausted.md)
- [⛔ The concierge is TWO faults stacked. Topping up fixes the newer one and leaves a ~94% failure rate in place.](2026-08-17T0015Z-concierge-is-TWO-faults-topping-up-leaves-a-94pct-failure-rate.md)

## 2026-08-16 — 33 filings

- [`panini_sale_price_capture_dry_days` is CRYING WOLF — it watches a field abandoned on 2026-08-08 while the live replacement works](2026-08-16T2355Z-panini-sale-price-is-wallet-scoped-not-a-lighter-payload.md)
- [`unmapped-sales-nfl_all_day` — the resolver is stuck in December, and the approved lever is NOT lossless](2026-08-16T2145Z-unmapped-resolver-is-stuck-in-december.md)
- [Daytime monitor — 2026-08-16T21:06Z (14:06 PT)](2026-08-16T2106Z-daytime-monitor.md)
- [✅ RESOLVED — the denominator existed all along: `fmv-recalc-heartbeat`. It was in my own 16:40Z query output and I read it as noise.](2026-08-16T2030Z-RESOLVED-the-denominator-existed-fmv-recalc-heartbeat-and-I-had-it-at-1640Z.md)
- [⛔⛔ CORRECTION #2 — `pipeline_runs` recorded **1 of 6** `fmv-recalc` invocations. My "deterministic page-0 poison" was a SELECTION ARTIFACT.](2026-08-16T2020Z-CORRECTION-2-pipeline_runs-sees-1-of-6-fmv-recalc-invocations.md)
- [⛔ CORRECTION — the FMV sweep failure is **NOT saturation**. Page 0 fails deterministically, and it will not self-heal.](2026-08-16T2015Z-CORRECTION-the-fmv-sweep-is-NOT-saturation-page-zero-is-deterministically-poison.md)
- [The institutional wallet walk is unstable, and everything derived from its diff is fiction](2026-08-16T1930Z-the-institutional-wallet-walk-is-unstable-and-its-diff-is-fiction.md)
- [pg_cron never STARTS ~2-4% of all scheduled ticks, and a lost tick writes no `pipeline_runs` row](2026-08-16T1921Z-pg-cron-loses-2-to-4-pct-of-all-ticks-and-writes-no-row.md)
- [86 anon-executable SECURITY INVOKER functions are invisible to `check_secdef_anon_exec_drift()`](2026-08-16T1910Z-86-anon-executable-invoker-fns-are-invisible-to-the-secdef-drift-check.md)
- [✅ FALSIFIER PASS 18:55Z — leg 324 fired, the arm CLEARED to 11.84. ⏰ The predicted RE-BREACH at ~20:07Z is still ahead.](2026-08-16T1855Z-FALSIFIER-PASS-leg-324-fired-arm-cleared-re-breach-still-expected-2007Z.md)
- [All Day realized pull value is capped at ~14% by pull ingest, not by the rollup — and the TS dist_id "collapse" is a maturation curve](2026-08-16T1840Z-allday-realized-pull-value-is-capped-at-14pct-by-pull-ingest.md)
- [`fmv_current` does not push a JOIN predicate through its `DISTINCT ON` — 1.05M buffers to fetch 40 rows](2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md)
- [Two operator-only blockers, both currently degrading a live user-facing path](2026-08-16T1750Z-two-operator-only-blockers-anthropic-403-and-atlas-proxy.md)
- [✅ SHIPPED 17:38Z — the trust-health freshness view is APPLIED. Its first query proves the pre-split monolith needed **928.6 s of a 600 s budget**.](2026-08-16T1740Z-SHIPPED-freshness-view-applied-and-the-monolith-needed-928s-of-a-600s-budget.md)
- [`ownership-onchain-walk` has failed two consecutive daily ticks, and nothing watches it](2026-08-16T1734Z-ownership-onchain-walk-has-failed-two-daily-ticks-unwatched.md)
- [⛔ The 08-12 "cheapest first" fix for wmc FMV drift is FALSIFIED — the catch-all sweep already times out on **26 wallets**](2026-08-16T1710Z-the-08-12-cheapest-fix-for-wmc-drift-is-FALSIFIED-the-sweep-times-out-on-26-wallets.md)
- [The React #418 hydration class is wider than `/insights` — 17 more date/time sites, FILED not fixed](2026-08-16T1706Z-the-418-hydration-class-is-wider-than-insights.md)
- [✅ VERIFIED 16:47Z — the `:13` collision fix passed its positive control. And the "contradiction" was never one.](2026-08-16T1650Z-VERIFIED-the-13-collision-fix-passed-its-positive-control.md)
- [2026-08-16T16:40Z — `fmv_sweep_wedge_hours` is diagnosed: the sweep FINISHED its catalogue pass, then died on the next pass's first page. Its dedicated stall arm reads **49.0 against breach 50.**](2026-08-16T1640Z-the-fmv-sweep-climber-is-diagnosed-and-its-own-stall-arm-is-1-point-from-firing.md)
- [The `:13` pg_cron collision — ✅ FIXED 2026-08-16, and the "operator-only" premise in this title was WRONG](2026-08-16T1630Z-the-13-collision-is-operator-only-and-thats-why-it-persists.md)
- [2026-08-16T16:15Z — the leg split will clear, RE-BREACH for ~40 min, then go green; and `pipeline_runs_daily` nearly made me file a fake 4-hour stall](2026-08-16T1615Z-leg-split-will-re-breach-at-2007Z-and-runs-daily-is-a-6h-stale-rollup.md)
- [DECISION — `rpc-panini-squeeze-v2`'s "not yet public" footer is WRONG and has been for 15 days: refresh it](2026-08-16T1600Z-DECISION-panini-squeeze-artifact-footer-is-15-days-stale.md)
- [`candy-editions-ingest`: the `maxDuration` lever is EXHAUSTED, not unshipped — and the route is not the defect](2026-08-16T1545Z-candy-editions-the-maxDuration-lever-is-EXHAUSTED-not-unshipped.md)
- [Daytime monitor candidates — 2026-08-16T15:25Z (~08:25 PT, first-tick)](2026-08-16T1525Z-daytime-monitor.md)
- [⛔ DO NOT RUN THE `:13` STAGGER — it is harmful as written, and it is currently QUEUED as "ready-to-run"](2026-08-16T1520Z-the-13-stagger-is-REFUTED-do-not-run-it.md)
- [Session close — 2026-08-15/16, Cowork cloud: the gate-key rotation item is closed, and three of my own filings were refuted](2026-08-16T1500Z-session-close-gate-key-closed-and-three-of-my-filings-refuted.md)
- [The trust precompute is starving leg-by-leg — and the fix I filed 15 h ago is already obsolete](2026-08-16T1455Z-trust-precompute-starving-leg-by-leg-and-my-own-fix-is-obsolete.md)
- [The gate-key rotation item is CLOSED — all 14 gate-keyed crons verified passing](2026-08-16T1455Z-gate-key-rotation-item-is-CLOSED-all-14-verified.md)
- [Daytime monitor — 2026-08-16T14:46Z (2026-08-16 07:46 PT · first tick of day)](2026-08-16T1446Z-daytime-monitor.md)
- [MEMORY / CORRECTION — `cron_heavy`-owned pg_cron jobs ARE reschedulable from the MCP/SQL editor; the "needs superuser/dashboard" claim is WRONG](2026-08-16T0030Z-cron-heavy-jobs-ARE-reschedulable-from-mcp-via-set-local-role.md)
- [The wallet-backfill error classifiers miss object-shaped rejections, and the cost is a permanently-red mega-wallet](2026-08-16T0025Z-wallet-backfill-error-classifiers-miss-object-shaped-rejections.md)
- [Daytime monitor — 2026-08-16T00:15Z (2026-08-15 ~17:15 PT)](2026-08-16T0015Z-daytime-monitor.md)
- [R8's heal would write TEAM NAMES into `editions.player_name` — do not run it](2026-08-16T0010Z-R8-would-write-team-names-into-player-name.md)

## 2026-08-15 — 20 filings

- [`remap_topshot_realign_miskeyed_subeditions` is SCAN-bound, so the filed p_limit fix is a no-op](2026-08-15T2350Z-realign-is-scan-bound-not-row-bound.md)
- [The driver-message leak has a SIXTH spelling, and both shared guards are blind to it by construction](2026-08-15T2341Z-the-driver-message-leak-has-a-sixth-spelling-in-a-sibling-key.md)
- [The trust-precompute 999 sentinel is unreachable on a timeout, and the fix is structural](2026-08-15T2240Z-the-999-sentinel-is-unreachable-on-a-timeout.md)
- [The Panini throughput gate will self-silence on the collapse it is currently catching](2026-08-15T2140Z-panini-throughput-gate-self-silences.md)
- [`drain-conflated-subeditions`: the route really is dead, but R7's stated impact is wrong — and the real one is worse](2026-08-15T1930Z-the-drain-is-dead-but-not-for-the-reason-filed.md)
- [The static-extension bypass is REAL — but the proof it ships with is not, and the control test settles it](2026-08-15T1838Z-static-ext-bypass-is-real-but-its-headline-proof-is-not.md)
- [Panini ingest: enumeration stops early, throughput down ~6×, and the freshness check is blind to it](2026-08-15T1830Z-panini-enumeration-stops-early-and-the-freshness-gate-is-blind-to-it.md)
- [Daytime monitor — 2026-08-15T~1810Z (≈11:10 PT)](2026-08-15T1810Z-daytime-monitor.md)
- [The nightly reconcile is failing and the cards are stale — but the proposed query-shape fix is REFUTED by measurement](2026-08-15T1700Z-reconcile-saved-wallet-stats-the-query-shape-fix-is-refuted.md)
- [Three heavy pg_cron jobs collide at minute :13 — the saturation has a schedule, and the fix is two `cron.alter_job` calls](2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13.md)
- [`fmv-recalc` is not running less — it is being KILLED at maxDuration, and nothing watches that](2026-08-15T1600Z-fmv-recalc-is-not-running-less-it-is-being-killed.md)
- [R4 is a CATALOG COVERAGE gap, not an indexer regression — and the FK is what makes it unfixable in place](2026-08-15T1530Z-R4-is-a-catalog-coverage-gap-not-an-indexer-regression.md)
- [Daytime monitor — 2026-08-15T15:10Z (~08:10 PT, first tick)](2026-08-15T1510Z-daytime-monitor.md)
- [The platform has TWO serial-multiplier models, and deep-audit run 2's P2 compared the homepage against the wrong one](2026-08-15T1507Z-two-serial-multiplier-models-and-the-audit-p2-is-wrong.md)
- [`refresh-insights-cache` fails to warm half its boards and has logged `ok: true` every single time](2026-08-15T1200Z-the-insights-cache-warms-half-its-boards-and-reports-perfect-health.md)
- [`pinnacle_fmv_history` silently drops the ASK_ONLY revision — 776 renders currently show a history value the catalog never published](2026-08-15T0620Z-pinnacle-fmv-history-silently-drops-the-ask-only-revision.md)
- [Daytime monitor — 2026-08-15T06:12Z (off-hours, 23:12 PT Aug 14)](2026-08-15T0612Z-daytime-monitor.md)
- [The `pg_net_http_403` CRITICAL is ONE job, and the Pinnacle "deployed or ineffective?" question is closed](2026-08-15T0540Z-the-403-critical-is-one-job-and-the-pinnacle-deploy-question-is-closed.md)
- [The entity-page timeouts are TWO families, and the biggest one is not a slow query](2026-08-15T0450Z-the-entity-page-timeouts-split-into-two-families-and-only-one-is-a-slow-query.md)
- [`refresh_wmc_fmv_changed` is the #2 disk reader and it is NOT a defect — it is the price of the `wmc.fmv_usd` denormalization](2026-08-15T0350Z-refresh-wmc-fmv-changed-is-the-price-of-the-wmc-denormalization.md)

## 2026-08-14 — 11 filings

- [The Top Shot catalog walk faulted 11 of 258 sets and nothing watches that counter](2026-08-14T2300Z-topshot-catalog-walk-faulted-11-sets-and-nothing-watches.md)
- [Two schedulers run the same wmc FMV propagation, and they lock each other out](2026-08-14T2230Z-two-schedulers-run-the-same-fmv-propagation-and-lock-each-other-out.md)
- [The Pinnacle FMV drift guard compares `pinnacle_catalog` to itself](2026-08-14T1930Z-pinnacle-fmv-drift-guard-is-a-tautology.md)
- [`get_pack_detail_bundle` cold-scans 3k× per pack page — the top user-facing error on the board](2026-08-14T1830Z-pack-detail-bundle-cold-scan-is-the-top-user-facing-error.md)
- [All Day's WAF 403 is almost certainly a ONE-LINE env change — `ALLDAY_PROXY_URL` route](2026-08-14T0500Z-allday-waf-403-is-a-one-line-env-fix.md)
- [Search players by college — a real collector hook RPC cannot answer today](2026-08-14T0330Z-search-players-by-college.md)
- [Daytime monitor — 2026-08-14T03:12Z (~20:12 PT, 08-13)](2026-08-14T0312Z-daytime-monitor.md)
- [Narrative search does not work: set names outrank the prose that answers the question](2026-08-14T0310Z-narrative-search-is-outranked-by-set-names.md)
- [Three older swallowed ledger headings (2026-08-11), unrepaired](2026-08-14T0210Z-three-older-swallowed-ledger-headings.md)
- [`/api/search` has no smoke probe, and it now has two consumers](2026-08-14T0204Z-api-search-has-no-smoke-probe-and-now-has-two-consumers.md)
- [Daytime monitor — 2026-08-14T00:14Z (~17:14 PT, 08-13)](2026-08-14T0014Z-daytime-monitor.md)

## 2026-08-13 — 14 filings

- [Profile flair + social-preview backlog (Claude Code, 2026-08-13)](2026-08-13T2345Z-profile-flair-and-social-preview-backlog.md)
- [`[collection]/analytics` renders a failed fetch as an empty market — 8 sections, 1 already fixed](2026-08-13T2340Z-collection-analytics-tabs-render-a-failed-fetch-as-an-empty-market.md)
- [The schema-cache 500s are SELF-INFLICTED: one ~20-second burst of user-facing errors per migration we apply](2026-08-13T2320Z-the-schema-cache-500s-are-self-inflicted-by-our-own-migrations.md)
- [The Sentry board triaged against the live DB — 2 reds were stale, 3 were fixed today, 6 are real](2026-08-13T2230Z-sentry-board-triaged-stale-vs-live.md)
- [Two `.from()` table reads on the edition page are still unbounded — the RPC half is fixed, this half is not](2026-08-13T2155Z-entity-page-from-table-reads-are-still-unbounded.md)
- [`get_series_detail` is a live, tens-of-seconds PUBLIC page query (Sentry NEXTJS-27), and the two obvious fixes are both WORSE](2026-08-13T2115Z-series-detail-is-a-live-20s-public-page-and-two-obvious-fixes-are-falsified.md)
- [Golazos is genuinely market-limited (measured ceiling ~2.8%), and the trust board's "stale" metric does not mean what its name implies](2026-08-13T2030Z-golazos-is-genuinely-market-limited-and-two-different-stales.md)
- [Inbox triage — 2026-08-13](2026-08-13T2000Z-inbox-triage.md)
- [The AllDay drain attribution is settled (keep jobid 22), and the insider-detector telemetry can drop 12 scans to 3](2026-08-13T1950Z-allday-drain-attribution-settled-and-the-insider-telemetry-merge.md)
- [Both open attribution questions are CLOSED — and neither needed the instrumentation we thought](2026-08-13T1930Z-403s-fully-attributed-and-jobid22-cleared.md)
- [Correction to the `get_allday_unresolved_pulls` prescription — the `ORDER BY` is load-bearing, and dropping it would break the only useful work this pipeline does](2026-08-13T1845Z-allday-pull-drain-is-a-forward-resolver-not-a-backlog-drain.md)
- [Rank the DB by disk reads and cache-hit ratio, not by time — and the one "obvious" index that turned out to be a regression](2026-08-13T1730Z-disk-read-ranking-and-the-pack-rips-plan-defect.md)
- [The recurring `pg_net_http_403` CRITICAL is ONE job — jobid 16 — and it is one of the three D2b calls "rotated + verified"](2026-08-13T1530Z-pg-net-403-attributed-to-jobid-16.md)
- [Daytime monitor — 2026-08-13T14:53Z (~07:53 PDT, first-tick-of-day)](2026-08-13T1453Z-daytime-monitor.md)

## 2026-08-12 — 9 filings

- [The board-warm failures now have names, and the numbers say capacity — not a missing index](2026-08-12T2330Z-board-view-timeouts-now-named.md)
- [pg_cron jobid 16 is 403ing 100% of its dispatches — real misconfiguration, LOW data impact, but it makes a brand-new CRITICAL arm permanently red](2026-08-12T1354Z-jobid16-403s-and-a-newly-critical-arm.md)
- [Three follow-ups on the D2 outage — one hazard, one confirmation, one fix that isn't a new monitor](2026-08-12T0430Z-suppression-predicate-and-secret-echo.md)
- [AllDay GraphQL returns 403 (HTML WAF block) through `ALLDAY_PROXY_URL` — edition hydrate may be silently dead](2026-08-12T0428Z-allday-graphql-403-waf-block.md)
- [Finding (CORRECTED) — the STALE label does not survive denormalization into wmc](2026-08-12T0358Z-stale-label-lost-in-wmc-denorm.md)
- [RESOLVED — the pack-opens "spork stall" was a 403 auth outage across 7 pg_cron jobs](2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md)
- [Daytime monitor candidates — 2026-08-12T03:09Z (≈2026-08-11 20:09 PDT)](2026-08-12T0309Z.md)
- [Decision-ready — `topshot_first_mint_trophy_stats` slow board: root-caused, urgency re-scoped, index-vs-precompute settled](2026-08-12T0056Z-first-mint-trophy-stats-index-vs-precompute.md)
- [Daytime monitor — 2026-08-12T00:12Z (≈17:12 PDT Aug 11)](2026-08-12T0012Z.md)

## 2026-08-11 — 2 filings

- [Inbox — 2026-08-11T17:46Z (10:46 PDT Aug 11) — Claude Code (interactive, read-only DB)](2026-08-11T1746Z-precompute-split-silent-stale-under-role-timeout.md)
- [The gate-key rotation — sized, and an ordering that does NOT reproduce the outage](2026-08-11T0300Z-gate-key-rotation-runbook.md)

## 2026-08-10 — 3 filings

- [Daytime monitor — 2026-08-10T21:07Z](2026-08-10T2107Z-daytime-monitor.md)
- [Queued — the liveness probe can be pruned by the planner, and 2 boards are still genuinely slow](2026-08-10T1900Z-board-liveness-probe-prunes-and-remaining-slow-boards.md)
- [Queued — cron budget headroom audit, the post-ship closes, and the next MV lever](2026-08-10T0555Z-cron-budget-headroom-audit.md)

## 2026-08-09 — 1 filing

- [PARTIALLY DRAINED — deals/rookies public-board backing views are I/O-bound](2026-08-09T1941Z.md)

