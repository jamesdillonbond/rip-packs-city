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

1. **[P2, Trevor, 1 night] Candy MLB: is the market still trading?** Magic Eden's activity feed for `2026_mlb_base_series_icons_candy_digital` has **no event of any type (list, delist, bid, buy) since 10-12 7:24 AM PT**. Our indexer is complete: all 98 buys in ME's newest 500 activities are in `sales`, matched by signature. Positive control: another collection's ME feed had an event 1 minute old, so the API is fine. ME still shows 1,497 listings (we hold 1,498). Candy's update-authority account is sending a failing transaction every ~30 s (`Custom 34`). The 10-13 pass read this at 28.8 h as "low volume, not a stall"; that call is now refuted. **Ask:** check candy.io — paused, migrated, or season-locked? If trading moved to OpenSea, #58's key is the way back to Candy prices. ~~The trust breach stays red until ME shows activity again or the lane changes source.~~ ⓘ **Update ~7:20 PM PT:** the breach went quiet because another session retuned the arm at ~6:4x PM PT (migration `…candy_sales_stale_indexer_health_aware`, applied straight to prod and recovered into git by the auto-recover bot in `1200a4dd1`; no ledger entry seen). It now breaches at once if the Candy indexer is unhealthy (no ok run in 7 h, or >50 new unresolved sales in 48 h); otherwise only after 168 h. Candy is still silent (newest sale 10-11 8:21 PM PT), so it pages again ~10-18 8 PM PT if nothing trades. The question for you is unchanged.
2. **[P2, Trevor, 1 night] Golazos market frozen?** Same ask as Candy — is it still trading? Evidence under "Continued" below.
3. **[P-low, Trevor, ~20 nights] #58 `OPENSEA_API_KEY`** — see item 1. Way back is in ledger 10-13 6:35 AM PT.
4. **[P-low, Trevor/operator, 3 nights] `drop_scratch` residue** (~185 MB `flowty_archive.scratch_*`, Trevor's data): SQL editor only.
5. **[P-med, Trevor, SQL editor, 1 night] Run `docs/pending-sql/audit_20261014_golazos_sales_v1_backfill_finished_suppression_made_permanent.sql`.** `cursor_stalled · high · golazos_sales_v1_backfill` has paged since 5:00 PM PT 10-14, when its bounded suppression lapsed. The row's own lapse instruction says to make it permanent once the cursor sits at the floor 137,390,146, and it has since 09-30 (parent lane 8/8 ok daily). `apply_migration` timed out 3× without applying (held for confirmation). The file checks its own preconditions. After running it, `git mv` it to `supabase/migrations/<YYYYMMDDHHMMSS>_<stem>.sql` (any fresh UTC timestamp) and commit, so the repo records it. The SQL editor writes no `schema_migrations` row, which is fine: `migration-parity` only checks the other direction (every production row has a committed file).
6. **[P-low, Trevor, SQL editor] Retire the `topshot-misattrib-drain` suppression:** `DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'topshot-misattrib-drain';` Its own predicate (≤ 500 open) is false at the Atlas resolver's measured floor (705), it silences nothing live (lane retired 09-08), and its text says "delete it, do not renew". It otherwise expires 12-05. See known-issues #101 datapoint.

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

## Continued (~6:17 → ~6:40 PM PT, Trevor: "Don't stop until there's nothing left unresolved that you can handle")

- **Shipped `5e47b70a4`: #191 closed.** All Day now gets the same cap confirmation as Top Shot/UFC. It runs only after a complete studio walk, and only when an independent on-chain count equals the walk's on-chain half (`0x6d1f8c18412c6abc`: 147 cached, 2 held).
- **Shipped: `topshot-onchain-art-backfill` stops re-reading its own head.** 300 of 300 misses per run, while ~9,000 resolvable older editions were never reached. It now runs two legs: fresh NULL-art drops, plus a cursor walk over the legacy-URL editions. The legacy CDN is NOT dead (17/17 samples serve); the IPFS move is for durability. See the ledger.
- **The rest of the "found N, wrote 0" sweep is benign, measured:**
  - `pack-pulls-id-neighbours`: 41 pulls whose id neighbours disagree or are >50 ids away. They are unnameable by design until the corpus grows.
  - Pinnacle/Golazos pack-open ingests: row counts EQUAL the upstream API totals (91,471 / 78,830). Opens come in drop bursts; Pinnacle's last was 10-09, while its sales run normally (172/24 h).
  - `price-pinnacle-pack-opens`: 38 opens wait on pin FMVs; it already rotates least-recently-tried first.
  - wallet-backfill dispatch/UFC/Golazos: these are stats-only rows.
- Vercel runtime errors, 3 h: 1 (the known cold dist-5048 read).

## Continued (~6:40 → ~8:05 PM PT, Trevor: "Keep going", then "work through anything still unresolved")

- **Shipped `003d8a4f8` (verified live): Top Shot pack pages read Dapper's live per-dist counts.** Packs remaining, depletion and pull odds had read compute-topshot-pack-ev's v20 metadata, frozen since 08-28, under a footer saying "live". They now prefer `topshot_atlas_dists` (3,169 dists, re-read every ~2 days) when valid and newer. The observed-opens floor refutes it the same way it refutes v20 (9 dists). A failed read keeps v20 with its old stamp. This was #74's missed half. Live: 5048 → "134 of 22,068 · as of 17h ago".
- **Shipped `8c7756be3`:** (a) /ufc/overview's About card no longer promises a sniper on a closed market, and the closed-market guard gains an About-card trading-claim arm, proven red on the old copy; (b) the market-cap tile's "Unknown" now names its real cause ("no price for this edition yet" on 253:9148 instead of "no burn count published" beside "Burned 0").
- **Found by a live rendered sweep of 15 pages** through the Vercel MCP fetch, which reaches the site where the sandbox proxy cannot (tooling-gotchas.md).
- **Measured, no change:** the misattribution backlog is at the Atlas resolver's floor (705; 695 never traded on Dapper's marketplace), so the "<500 in ~2 d" forecast is withdrawn (#101 datapoint, queue item 6). The subedition chain queue is catching up daily. Pinnacle's wmc `fmv_confidence` column is unused (the RPC supplies catalog confidence). All 258 tracked wallets were refreshed within 17 h. FMV confidence is calibrated (TS HIGH 9.5 % / MEDIUM 15.0 % / LOW 25.0 % median error). 60/60 scheduled workflows are green. Pack 5048's cold read is 814 ms against a 5 s budget.
- **Candy trust breach went quiet for a reason that is NOT recovery:** another session retuned the arm at ~6:4x PM PT (applied straight to prod, recovered by the bot in `1200a4dd1`). It now pages at once if the Candy indexer is unhealthy, otherwise after 168 h (~10-18 8 PM PT if still silent).
- **Golazos v1 suppression:** see queue item 5 (pending SQL, 3 timeouts).

- **Homepage FMV preview (`f7ee35e3a`, deployed):** the server HTML no longer renders a hardcoded $148.00 and invented ×12 / ×2.8 serial prices under "LOADING FMV…"; LIVE labels serials with the demo's fitted multiplier.

## Watch next pass
- pdx1: pack-detail and market-cap-tile `read exceeded` groups should stay near zero. A recurrence on a **warm** dist means a DB-side read to measure.
- #185: the total row must still read `ok` **during** the 10-15 ~4:17 PM PT re-walk. That's the case the fix exists for.
- Candy: re-run the ME activities probe (`net.http_get` on `/v2/collections/<symbol>/activities`) before calling it anything else.
- Top Shot pack pages: the as-of on Packs remaining / Pull odds should read hours to days, never weeks. A Top Shot pack showing weeks means its Atlas row went stale or was refuted. Check `topshot_atlas_dists.summary_fetched_at` for that dist.
- `topshot-onchain-art-backfill` (`b4e2c723c`) — ✅ first run verified 8:22 PM PT 10-14: 237 thumbnails + 263 videos, 0 errors, cursor set, 9,265 → 8,994, 6/6 new IPFS URLs serve. Each later run should write `thumbs_filled`/`videos_filled` > 0 with an advancing `extra.next_cursor`, and the legacy-URL candidate count should fall from ~9,265 by ~300 a run (≈ 4 days a lap).
- Phantom holdings (`f37db838e`, `2f97fe8f9`, `5e47b70a4`): tracked wallets' wmc counts should equal holdings after their next walk (`0x4ab8b294112f182c` → 0 is already verified); `unseen_delete_skipped = suspiciously_large` should reach 0.
