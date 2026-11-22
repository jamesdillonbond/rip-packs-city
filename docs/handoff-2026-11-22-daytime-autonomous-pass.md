# Daytime autonomous pass — 2026-11-22 (1:22 PM PT →, Claude Code cloud)

**Verdict: GREEN. 15 shipped (5 migrations + 1 one-off maintenance, 10 code changes), 0 reverted** (updated ~3:40 PM PT; items 8–15 below). Trevor: "work autonomously for the next 4 hours … fix any issues you encounter." Push worked directly to `main` from this session (dry-run first). A concurrent Panini/Candy thread was active all afternoon; I stayed out of its lane except for one Panini data-loss fix it could not be reached for (`ListAgents`: no reachable session).

## Shipped (newest first; each has a ledger entry with its revert path)

1. **`20261122221137` — Panini sales ingest accepts 6-number `packcard-` keys.** The Sentinel "Panini Ingest" arm warned at 2:04 PM PT: 42 sale records/24 h dropped (`packcard-2077_403382_10871318_139_15_25`). This morning's Moonbirds fix took 5 numbers; product 2077 has a 4-part card. All 6 sampled keys resolve to an existing edition; the 3 affected editions had **0** stored sales, so the change cannot double-count; 27 serial last-sales seeded.
2. **`d78534273` — member emails use the email red** (`#e55a4c`). The weekly portfolio email (logo, CTA) and the legacy digest used the web red. A new tree-walking guard covers `lib/emails/**` plus both digest senders.
3. **`119e3e39b` — the weekly email's new "Sealed packs" block cannot print an unpriced `$0.00`.** It was found by checking today's `88731d9fc` against live rows, before its **first send Mon 11-23 8:33 AM PT**. 5 of 58 snapshots read held 1 / listed 0 / value 0.00. It also read an older night as this week's and said "4 sealed packs" when 3 were priced. Dashboard Value/30D: a held-but-unpriced 0 is now null. Deployed READY.
4. **`20261122214417` — the All Day thin-sale haircut stopped re-"cutting" rows its bid-floor trigger holds at price.** 171 of 177 reported cuts were phantom. `algo_version` grew `_haircut_bidfloor` on every pass, up to ×7. The writer's count and dollars counted rows it did not change. Prices were never wrong. The pin gained All Day bid fixtures (it fails on the old bodies).
5. **`fadc28219` — the series OG card prints the page's label.** Top Shot on-chain 6/7/8 read "Series 5/6/7" on the social card over a page titled "Series 2023-24". Verified on the live PNG.
6. **`20261122212737` + one-off `VACUUM (ANALYZE)` of `sales_2023`–`sales_2025`.** The set page's Recent Sales panel was the top Vercel error group (6/24 h statement timeouts). Cause: `sales_2025` was 76 % all-visible, because backfill inserts never cross the default insert trigger. holo-icon 16.7k → 14.0k buffers; durable via `autovacuum_vacuum_insert_scale_factor = 0.01` on 2020–2025 (no new cron lane).
7. **"RPC Live Health" artifact republished (v3)** with two stale notes corrected. Item B's "merger not yet applied" was wrong: 0 UUID-keyed Top Shot editions remain. The Pinnacle "earlier days empty" note was also stale. This closes WEEKLY-SURFACE-QA-PROSE.

## Shipped later in the pass (~2:15–3:00 PM PT)

8. **`20261122221721` + `6690b43f7` — the weekly email states how much of a member's change is OUR repricing.** Tomorrow's first send would have said "−49.6 % this week" to two members. For the first, −$27,587 of −$37,619 is the 11-17 FMV restatements on 18 held editions; for the largest portfolio it is −$34.6k of −$52.4k. The email now adds "Includes about −$X from our price corrections on N of your editions this week — not market moves". The subject drops the % when repricing is ≥ half the move. A failed read skips the member. The same commit repaired `PANINI_SALE_KEY_SHAPES`; `main` had been red on that guard since my `4fdbbafff`.
9. **`034172479` — four review findings:** the packs-tab "$0 at floor ask" over zero priced listings; offer-fill chain reads get a 90 s wall-clock budget; All Day `resolvedOnChain` counts placed fills only; the X reminder says "opens" for an unconfirmed Pinnacle RSVP.
10. **`20261122223919` + `ddae8e5bd` — the Sentinel drop-day arm counts unpriced sales.** Sales with no published price had dropped out of both sides. **2026-11-18 18:00–24:00 UTC had 178 of 1,009 Top Shot sales (17.6 %) with no published price at the sale, and nothing saw it.** The arm now warns at ≥ 10 %.
11. **`911c765f9` — the art backfill rests only after an error-free lap** (it judged the last run only).
13. **`d4c86254c` — the sealed-pack "this week" change is like-for-like only** (held and listed counts unchanged). Same commit unblocked `main`: `lib/dashboard/aggregate.ts:112` (the portfolio thread's `40ff10b39`) failed the registry own-property guard.
14. **`d182d2ba2` — Candy review fixes:** chain-sales parks every Candy collection's fill from a fetched transaction; before, a sweep filling two collections in one tx lost the second, because its signature was then "known" (no live instance yet). A run with ≥ half of its collections refused is no longer ok. Sibling workers stop on a throw. Buyer-paid counts non-rate-limit JSON-RPC errors as errors; before, they were refusals that stopped runs green. Panini commits reviewed clean.
15. **`390b9b886` — no sealed-pack weekly change against a BACKFILLED night.** The portfolio thread's 3:20 PM PT backfill (`20261122231506`) puts estimates on past snapshots, including tomorrow's comparison night 11-16.
16. **`20261122232956` — `public.scratch_backfill_pk_trevor` locked down (~3:30 PM PT).** It is the portfolio backfill's scratch table: one owner's pack buy/rip/sell rows, ~3,981 of them. It was created in `public` with RLS off and an anon SELECT grant. `check_public_security_invariants` and `/api/smoke-test` were red from ~3:13 PM PT; 6 hard failures were in Vercel. Fixed with RLS on and anon/authenticated revoked; owner/service_role bypass, so the backfill is unaffected. Verified: 0 violations, anon SELECT false, the next Smoke Tests run green. **Drop the table when the backfill finishes.**
12. Review method: a background reviewer read today's 10 non-Panini/Candy commits; 6 findings, all fixed (items 9–11).

## Measured, no change (recorded so nobody re-chases them)

- **All Day weekly paired backtest** (lapsed since 11-05; nfl-all-day.md "Read 11-22"). Paired, ALL is level (67.2 vs 67.3) and HIGH wins. **LOW is −9.1 / −6.4 two weeks running, so R125's rule fires.** The 8-week series shows published winning weeks 3–7 on both metrics, so there is **no lever**. Re-read ~11-29, paired.
- **#210's "0.90 haircut" lead** does not hold on 4 more weeks (newest 2 favour 0.75, older 2 favour 0.90–1.00). Recorded on #210.
- `get_set_activity` remaining cost after the vacuum: a further cut needs a new covering index on `sales` (~100+ MB), which isn't worth it for a panel that degrades honestly.
- `fmv_clamp_disconnected_ask` has the same latent shape as the haircut loop, but 0 All Day clamps fired in 30 d and there is no fingerprint. Left alone.
- `rpc-topshot-pack-opens-history` (job 56) returns `done:true` every tick by design ("deliberate standby", packs.md). Not a cut.
- Health: security invariants clean, 0 trust breaches, 0 stalled, 0 HIGH alerts, `check_when_others_timeout_blind` 0, client-error beacon 0 real in 7 d. Advisors: 8 mutable-search_path functions, all non-SECURITY-DEFINER and not anon-executable (benign).
- Accuracy (`fmv_sales_backtest`, 7 d): Top Shot published 74.4 % within ±25 % vs naive 72.6 (HIGH 82.2). All Day is in the paired read above. Pinnacle (`pinnacle_fmv_sales_backtest`, 7 d, ~3:40 PM PT): published ≥ naive-5 on hit-rate in every tier (ALL 66.8 vs 61.9, n 974; HIGH 72.5 = 72.5; LOW 64.7 vs 61.4, WAPE 24.9 vs 35.7). The exception is the ASK_ONLY dollar-weighted error, 45.1 vs 33.1 (n 120; hit-rate 68.3 vs 45.0): a few large misses. Re-read before touching ASK_ONLY.

## Stale docs corrected

Golazos Flowty lane (retired 10-30), concierge #8, wallet #114, Pinnacle thp `rows_written` (fixed 10-18), and a drained 10-21 inbox filing marked in INDEX. Most "open" lines in the collection/feature roadmaps lag the register; the register (known-issues.md) is the truth.

## Carried-queue triage (the list every night pass copied forward since June)

| Label | Verdict | Evidence (live, 11-22) |
|---|---|---|
| BUYERBF-PERINVOCATION-WORK | closed | `topshot-buyer-backfill` 144/144 ok in 72 h, max 37 s (was 600–710 s, overlapping) |
| ALLDAY-V1-UNMAPPED-DRIFT | closed | 0 open `onchain_dapper_v1` unmapped All Day sales |
| WEEKLY-SURFACE-QA-PROSE | closed today | artifact v3 (above) |
| PIN-FMV-REKEY-WAVES 2/3 | closed 06-08 | legacy table dropped; 0 functions/views reference it |
| PIN-SYNC-CRON | closed | `pinnacle-sync` 3/3 ok in 72 h |
| P3-BUYERS | closed | `pinnacle-resolve-buyers` 216/216 ok in 72 h |
| DUPE1 | closed | 0 UUID-keyed Top Shot editions |
| Q2 / Q5 / Q6 | closed | route retired → pg_cron 12/12 ok · smoke uses `detect_stalled_pipelines` · Base lane off since 08-02 |
| N1 | closed | `snapshot-institutional-wallets` 6/6 ok |
| ANALYTICS-SMOKE-RESIDUAL | closed 06-14 | 144/144 ok |
| IPFS ×2 | parked by design | both "DEFERRED — do not build now" |
| VERCEL cost family | partly open | OBSERVABILITY-SAMPLING + FLUID-CONCURRENCY are Vercel dashboard settings — Trevor |
| A1-WORKER-PASSTHROUGH-CLEANUP | open, optional | 2 zero-caller routes in `workers/topshot-proxy`; deleting needs a wrangler deploy (Trevor) — fine to mark won't-fix |

## Queued for Trevor / Claude Code

1. **[P3, Trevor, 0 nights] Vercel cost residue:** check Observability sampling and Fluid concurrency once in the Vercel dashboard; then the label can be dropped.
2. **[P3, Panini thread, 0 nights] Lane budget:** 320 active pg_cron jobs vs the 318 baseline. Job 915 `panini-pack-ev-tier-shadow` (11:49 AM PT) has no paired retirement.
3. **[P4, Trevor/Claude Code, 0 nights] A1-WORKER-PASSTHROUGH-CLEANUP:** delete or mark won't-fix.
4. **Unchanged from the overnight handoff:** item 4 there (Top Shot gate week 2, read Mon 11-23 after ~3:37 AM PT) stands, and its three carriers are untouched. `fmv_accuracy_weekly` has no 11-16 row yet (expected).

5. ✅ **ANSWERED ~3:05 PM PT (strategy-2026-11-22.md Move 1 item 2): the 11-18 WNBA drop — 48 new editions, first price a median 1.6 h after first sale; the hot-lane lever is filed there.** Was: **[P3, Claude Code, 0 nights] What happened 11-18 ~10 AM–4 PM PT?** 17.6 % of Top Shot sales cleared with no published price (vs ≤ 3.2 % in every other 6 h window of 16 days). Likely a drop whose editions the hot lane did not snapshot in time. Find the editions (`sales_market` 11-18 18:00–24:00 UTC with no `fmv_snapshots` row at/before `sold_at`) and check `hot_lane_editions` for that window.

6. **[P2, portfolio thread / Claude Code, 0 nights] Four findings from a review of today's portfolio rework (`7fa4dfc84`, `eefb11849`, `f2ca69a21`).** NOT fixed here: that thread was shipping to these files at the time. Re-verify against HEAD first (`40ff10b39` / `d60490088` landed after the review).
   - (a) **The share link's preview card ≠ the share page.** `app/share/[wallet]/page.tsx` ~340/356 shows Moments incl. stale-priced + sealed packs and "N assets"; `app/api/og/share/route.tsx` ~133-141 still renders `shareHeadline().live` (total − stale, no packs, "N moments"). A wallet with $5k stale + $2k packs posts a card $7k below its page.
   - (b) **Total Assets silently drops packs while the pack read loads or fails** (`DashboardClient.tsx` ~1104, `ProfileClient.tsx` ~365, share page ~356 add `heldPacks.held` only on success). The "Adding sealed packs…" / "couldn't load" notes sit under Portfolio FMV only. The profile share button (`ProfileClient.tsx` ~579) can tweet the Moments-only total/count in that window.
   - (c) **"Panini included" is not true:** `get_wallet_collection_stats` has `AND c.slug <> 'panini_blockchain'`; `saved_wallets` holds no Panini rows (16 Panini identities in `saved_collector_identities`). Their cards are in neither Total Assets nor Portfolio FMV.
   - (d) **The single total lost its age.** The "as of Nh ago" caption (`cacheAgeHours`) was removed, while the Moments half can come from a cache hours old and the pack half from a ≤ 24 h cache fallback (`pickHeldValue`, `walletsFailed=0`, so no caption fires).

7. **[P2, Trevor, decision] A scratch table in `public` is a public table — 6th occurrence (10-03, 10-19, 10-31, 11-06, 08-30 ×2, today's).** Each fix has been a convention ("enable RLS in the same batch"), and today's leak was one owner's pack history. The durable fix, filed 08-30 and left as **your call**, is a `ddl_command_end` event trigger. It would enable RLS on any new `public` base table, making the already-HARD smoke invariant self-enforcing. It does not revoke grants, so product tables with policies are unaffected. The cost: a table needing anon read before its policy lands reads EMPTY rather than open. `postgres` here is not superuser and no user event trigger exists, so check that Supabase permits one before choosing. Not installed.

## Dated reads (also in focus.md, STEER 11-22 ~2:20 PM PT)

- Next `apply-fmv-haircut` run: `rows_written` ~25–40, not ~190.
- Panini dropped-key count for the six-number shape → 0; duplicate-shape query stays empty.
- Mon 8:33 AM PT email: no "$0.00" sealed-pack line.
- ~11-29: cold-partition visibility maps > 95 %; `get_set_activity` timeouts well under 6/day; All Day paired backtest.
- **Mon 8:33 AM PT email (repricing):** the dry run (`?dry=1`) lists `repricing_usd` per recipient. Members with a large 11-17 repricing get the disclosure line, and `skipped_incomplete` stays ~0; a jump means the repricing read is failing.
