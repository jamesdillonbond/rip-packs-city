# Health check + audit — 2026-10-14 (~4:44 → ~5:35 PM PT)

⚠ **ROUTED 3+ NIGHTS (first-line):** **#58 `OPENSEA_API_KEY`** — ~20 nights, Trevor-shelved 09-23; its three Candy lanes were parked 10-13 so it no longer reds anything. ⚠ It may matter again: see item 1 below (Candy's Magic Eden market went silent on 10-12).

> ⚠ **Scope line (environment):** This was a **Claude Code cloud session with the repo attached**; `git push --dry-run` exited 0 and every commit below was pushed directly. The sandbox could NOT reach `www.rippackscity.com` or Magic Eden through its egress proxy — those probes went through `pg_net` from the database instead. That limit is specific to **this cloud session**; Trevor's machine and Claude Code push and browse normally. **Commit these files as usual.**

**Verdict: GREEN with one upstream RED · 4 shipped · oldest routed: #58 OPENSEA_API_KEY ~20 nights.** Trevor asked for a full health check and audit, then fixes. Every instrument was read; three real defects were found and fixed with measurements before and after; one upstream problem (Candy) needs a person.

---

## Health — what was read

| Area | Reading |
|---|---|
| Stalled pipelines / zero-yield / WHEN-OTHERS-blind | `[]` / 0 of 326 / 0 |
| pg_cron, 6 h | 6,556 runs, **0** failures, 0 startup or statement timeouts |
| Site availability probe, 2 h | 23/23 ok |
| Security invariants / anon write / secdef-anon | all `[]`; Supabase advisors: 3 anon-secdef WARNs all allowlisted, 2 procedure `search_path` WARNs (known pin class); performance advisors INFO-only |
| Trust health | **1 breach: `candy_sales_stale_hours` 68.5** (item 1) |
| Accuracy, 7-day sales backtest | Top Shot published 13.8 % median abs error, ratio **1.000**; All Day 20.0 %, ratio **1.000** |
| Vercel runtime errors, 24 h | 18 low-count groups, all bounded-read timeouts (`read exceeded 5000/8000ms`) → **1 group after the pdx1 deploy** |
| Client-error beacon, 72 h | 10 events, **all Lightpanda bot** (`automated:true`); 0 real users |
| Scheduled GitHub workflows | 40 of 40 recent runs green (E2E DOM smoke, sentinel, ops monitor, migration parity, dependency audit…) |
| Edge functions, 24 h | 0 × 5xx; 403 ×3 (today's key rotation), 410 ×5 (R21 retirement probes) |
| Postgres error log, 24 h | clean |
| Alert rows | OpenSea ×3 (parked 10-13, age out ~10-16) · Panini collector walk 10/31 (all = by-design 10-min cap) · Atlas 403 INFO rows (attributed, nothing lost) |

## Shipped (all verified live)

1. **Vercel functions now run in `pdx1`, next to the database** (`99c9b4f3b`). The DB is in AWS us-west-2 (Oregon); `vercel.json` named no region, so every function ran in the default `iad1` (Washington, DC). Measured on one query: DB execution **0.14 ms** mean (238k calls) vs **~118 ms** median seen by the function. After the move, same log lines, warm: profile resolve **25–47 ms**, `fmv/demo` 417 → **170 ms**. Cache-miss renders return `x-vercel-id: pdx1::pdx1`. Guard `functions-run-in-the-database-region.test.ts` pins it (proven with a planted `iad1`). Vercel error groups 18 → 1 since. ⓘ The `region=` field in runtime logs is the edge PoP, not where the function ran.
2. **FMV charts stop logging recharts' size warning on every server render** (`cf19f9e82`) — the most frequent runtime-log line. The earlier `minWidth={0}` "fix" could not work (recharts warns only when BOTH starting dimensions are ≤ 0). Verified with two cache-busted edition renders: 0 warnings (was 1 per render).
3. **The issuer-held split ("inside packs vs reserve") stays published during the daily list re-walk** — migration `20261015001336` (`165567a96`). It read `pending` for ~75 min of every day because the tick nulled `list_done_at` at the start of each pass. Now the stamp is the last completed list; readers gate on its age (equally strict). **#185 closed:** the total row reads `ok` for the first time since 10-03 (1,706,375 in packs / 1,880,536 reserve). Applied as a guarded splice with the post-splice md5 asserted equal to the committed file; local DB suite 265/265.
4. **Register** (`eef177b2e`): #185 → ✅; #181 gains its 10-24 datapoint (below).

## Queued for Trevor / Claude Code

1. **[P2, Trevor, 1 night] Candy MLB: is the market still trading?** Magic Eden's activity feed for `2026_mlb_base_series_icons_candy_digital` has **no event of any type (list, delist, bid, buy) since 10-12 7:24 AM PT**. Our indexer is complete: all 98 buys in ME's newest 500 activities are in `sales`, matched by signature. Positive control: another collection's ME feed had an event 1 minute old, so the API is fine. ME still shows 1,497 listings (we hold 1,498). Candy's update-authority account is sending a failing transaction every ~30 s (`Custom 34`). The 10-13 pass read this at 28.8 h as "low volume, not a stall"; that call is now refuted. **Ask:** check candy.io — paused, migrated, or season-locked? If trading moved to OpenSea, #58's key is the way back to Candy prices. The trust breach stays red until ME shows activity again or the lane changes source.
2. **[P2, Trevor, 1 night] Golazos market frozen?** Same ask as Candy — is it still trading? Evidence under "Continued" below.
3. **[P-low, Trevor, ~20 nights] #58 `OPENSEA_API_KEY`** — see item 1. Way back is in ledger 10-13 6:35 AM PT.
4. **[P-low, Trevor/operator, 3 nights] `drop_scratch` residue** (~185 MB `flowty_archive.scratch_*`, Trevor's data): SQL editor only.

**Closed this session (not carried):** #23/#25 edge-function drift. The register has both ✅ (09-08, 09-25), and today's R21 work retired the remaining credential-literal functions. The topshot-active-listings feeder box has recovered (`stalled_pipelines []`).

## Scheduled decision — not a queue item
- **#181 (10-24):** the mainnet24 access node now fails at **DNS** (`Couldn't resolve host name`), not a handshake timeout, so it looks decommissioned. 410 `floor` probes (3 wallets) are routed only to it. Because `floor` is outside the lanes' `NOT IN ('done','failed')` gate, they hold four staggered chain-arrival lanes open (~55 worker-hours/day of sleeping slots; 0 cron failures, so harmless today). Retiring them on 10-24 closes both.

## Looked at, deliberately left alone
- **`v_topshot_parallel_premiums`** (2 board timeouts/24 h): measured **743 ms** fresh. The `pg_stat_statements` mean of 3.9 s pools data back to 08-11, so it is not usable. `edition_fmv_current`'s own comment says this view stays on `fmv_snapshots` (it needs sub-day correction latency). Not changed.
- **`get_pack_lifecycle_row` on dist 5048** (the 1 post-pdx1 error): 2.8 s cold / **24 ms warm** (1,858 disk reads). It's a cold-cache miss on a rarely viewed drop, the function was already optimized on 10-02, and the page degrades honestly.
- **Panini collector walk 32 % "failing":** all 10 failures are the by-design per-walk cap; the rotation resumes.
- **20 stale `wallet_moments_cache` pairs:** all are ad-hoc lookups (not seeded, not saved); they refresh when someone looks them up again.
- **Client errors:** bot-only.

## Continued (~5:50 → ~6:15 PM PT, Trevor: "Keep going")

- **Register triage:** the deep-audit register's P0/P1 rows are all closed or need you (R107); R123 closed 10-03. So this turn hunted new problems.
- **Shipped `f37db838e`: emptied tracked wallets are retired on positive on-chain proof.** A tracked (seeded) wallet that sold out a collection kept its cached moments forever. An empty `getIDs()` is (correctly) never a delete trigger, and the 14-day `prune_stale_wmc()` named as the backstop skips seeded wallets. Verified on chain: `0x8e655887a360cc3f` (137 Top Shot rows) and `0x4ab8b294112f182c` (54) hold a collection with **0** ids; `0x6d1f8c18412c6abc`'s two UFC rows (seen 2026-05-13) kept `ufc-enrichment-drain` failing every 15 min. A separate read now distinguishes "collection present, 0" from "unreadable"; only the former retires rows (Top Shot + UFC). All Day is excluded on purpose → **#191** (cap-blocked partial sell-off on a seeded wallet).
- **Golazos looks frozen (to you, with Candy):** newest sale **10-01**, newest pack open 10-06, and the storefront reconcile reads `live = 4,286` **exactly** across 37 runs over 4 days (0 inserted / closed / vanished from 230 sellers). The same reconciler on All Day churns hundreds a day, so the instrument works. Historically thin (several zero-sale weeks), but a perfectly flat book is new. No public notice found.
- **DB load, measured fresh (two pgss snapshots):** ~90 % of statement time is the chain-arrival / opener lanes' deliberate `pg_sleep` staggers; the real top disk reader is `atlas_listing_verify_tick` (~19k blocks/call, avg 8.1 s, 0 timeouts; its 09-18 optimisation was reverted for fleet harm — left alone). `net._http_response` is 1.4 GB on disk but 411 MB live (6 h TTL; the rest is reusable space) — 602 MB raw/6 h is the Atlas market feed's deliberate ~50-min page overlap (resilience against 403 bursts). Not changed.
- **Every pg_cron job ran on schedule** (the 20 not run in 26 h are all Sunday weeklies).

## Watch next pass
- pdx1: pack-detail and market-cap-tile `read exceeded` groups should stay near zero. A recurrence on a **warm** dist means a DB-side read to measure.
- #185: the total row must still read `ok` **during** the 10-15 ~4:17 PM PT re-walk. That's the case the fix exists for.
- Candy: re-run the ME activities probe (`net.http_get` on `/v2/collections/<symbol>/activities`) before calling it anything else.
