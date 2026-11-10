# Handoff — platform audit pass, 2026-11-09 ~10:03–10:45 PM PT (Cowork cloud)

> ⚠ Any limit named here is specific to **this cloud session**. Trevor's machine and Claude Code push normally. **Commit these files as usual.**

**Verdict:** healthy · 4 shipped · security invariants all `[]` · one new signal for Trevor (Candy's first sale since 10-11). Trevor's asks, in order: a deep audit across the platform; general housekeeping; the 10:04 PM PT Sentinel warns; roadmaps and collection feature parity.

## Shipped (each has a ledger entry with its revert path)

1. **R118 guard back to 0** — `check_when_others_timeout_blind()` listed `candy_collections_discover_collect` (shipped 11-08, a per-account loop parse guard). Added to the exclusion list with its loop argument: `20261110060836_audit_20261109_r118_exclude_candy_collections_discover_collect`. CI green on `7fc2154`.
2. **One `<h1>` per collection tab** — Panini Collection / Analytics / Product served two; the Packs tab of Panini and Candy served none (6 of 53 registry routes). `components/CollectionHeading.tsx` + 5 test cases.
3. **Public FMV methodology page** — no longer names Flowty as an ask source (retired 10-30); states that ask-based prices on Top Shot / All Day / Golazos are capped by recent sales; footer November 2026.
4. **`rpc-edge-fn-deploy` skill source** — the repo copy was the pre-Vault version (09-25); the installed copy has the 10-13/14 Vault gate. Repo source and bundle now match the installed copy.
5. **Docs:** `docs/strategy/feature-parity-2026-11-09.md` (every feature × every collection, gaps ranked) and a pointer from `docs/strategy/features/README.md`; inbox filing `2026-11-10T0645Z` (Candy revival).

## Measured, nothing to fix

- **Surface / SEO:** 303-page stratified sitemap sweep (111,866 URLs in 9 shards): 303 / 303 HTTP 200, every page with a self-canonical, description, og:image, branded title; none `noindex`; no duplicate titles; slowest 2.75 s.
- **Security:** `rpc_ops_snapshot().security` all `[]`; secdef-anon drift 0; response headers carry CSP, HSTS preload, `frame-ancestors 'none'`, nosniff, referrer and permissions policies; `npm audit --omit=dev` 0 high / 0 critical (7 low, all `@onflow/*`, no fix published).
- **Compliance:** ⛔ CORRECTED in the second pass (below): I wrote that commercial email "is blocked until the postal address is set" from reading the gate, not the runs. Both weekly emails are LIVE and sending (11-09: `weekly-digest` sent 8, `send-digest` sent 1), which means the gate's two conditions are met; the gate itself is as described (`lib/emails/sender-identity.ts`).
- **Price accuracy, 7 d:** Top Shot published ratio 1.00, 14.2 % median error, 69.2 % within ±25 % (n 18,253); All Day 0.92, 20.0 %, 59.0 % (n 3,811).
- **Concierge (4 anon probes, `probe-…` sessions):** FMV answer names its basis without a confidence tier; buying refused, trade room described; prompt-injection refused.
- **Pipelines:** `detect_stalled_pipelines()` `[]`; `check_zero_yield_lanes()` 0 offenders; the two `running_but_not_succeeding` rows (`wmc-metadata-selfheal`, `topshot-map-atlas-reconcile`) are fixed-awaiting-next-run (2:31 / 4:47 AM PT 11-10; a verification task is already scheduled).
- **Vercel runtime errors, 24 h:** 30 groups, all read-budget timeouts on known lanes; the largest is `/insights/market-pulse` (27 events) — see queued 2.

## The 10:04 PM PT Sentinel, re-derived

- **Edition Coverage 74.3 %** = Candy 190 of 22,768 editions priced; every other collection 100 %. Decision for Trevor (options in the parity doc).
- **Pipeline Success Coverage** — as above, awaiting the two overnight runs.
- **Trust Health:** `candy_ask_book_drop_pct` 92.7 → the 7:35 PM PT sweep retired 208 of 228 Magic Eden asks as owner-moved (65 sellers ↔ 66 new owners, near one-to-one: Candy's wallet migration, not a venue failure); ages out ~7:35 PM PT 11-10. `public_board_slow_count` 1 → `v_insights_trophies` 7,587 ms vs 7,000 at 4:28 PM PT. `edition_integrity_flags` 13,627 → 12,127 by ~10:41 PM PT, draining as focus.md expects. `candy_sales_stale_hours` 687 → 9.3 because a sale arrived (below).

## Queued for Trevor / Claude Code

1. **[P2, Trevor, new] Candy traded again:** one sale, 11-09 1:23 PM PT, $0.17, "2022 Uncut Diamond ICONs" on Magic Eden. `candy_revival_sales_since_recorded_silence` = 1 (BREACH). The arm asks for the `candy_mlb` row of `v_collection_marketplace_status` to be re-verified and updated — a value UPDATE the MCP holds, and a judgement on one print. Filing `2026-11-10T0645Z`.
2. **[P3, Claude Code, new] `/insights/market-pulse` initial read exceeds 8 s** — 27 events / 24 users in 24 h, the largest runtime-error group. Not measured further here.
3. **[P3, Trevor, new] Candy edition coverage** — choose (a) leave, (b) measure coverage over open markets and report Candy beside it, (c) price legacy editions from Magic Eden collection floors.
4. **[P3, Trevor, due ~11-14] `GITHUB_ACTIONS_READ_TOKEN` renewal** (already in known-issues; repeated because it has a date).
5. **[P4, Trevor, new] Terms page** still lists Flowty as an example third-party marketplace (`app/terms/page.tsx`, "Third-Party Marketplaces"). Left alone: legal copy.
6. **[P4, Trevor, housekeeping] Scheduled tasks:** eleven one-off tasks are disabled and spent (seven ended `auto_disabled_session_gone` in October without running: Dapper + Flowty recovery check, R133, autograph sweep check, #185 verify, Panini 7-day, chain-arrival tick, #169; R133 and the others were closed by later sessions). They can be deleted from the task list; nothing was deleted here.
7. **[P4, Trevor, housekeeping] Install three skill bundles** (repo newer than installed): rpc-surface-qa, rpc-artifact-ops, rpc-cron-ops.

## Not done, and why

- `metrics-latest.json` not rewritten — the 1 AM nightly pass owns it and runs in ~2 h.
- No signed-in Chrome walk and no mobile screenshot sweep this pass (both were run 11-06/07).
- The Supabase security advisors returned four lint families (RLS-no-policy INFO; search_path, anon and authenticated SECDEF-executable WARN); the repo's own invariant checks cover the same ground and read clean, so the 150 KB advisor list was summarised by family, not read row by row.

---

## Second pass — 11:14 PM → ~11:50 PM PT (Trevor: "Keep going and do all you can … use chrome … make your own decisions")

**Did the things the first pass skipped:** a signed-in walk in Trevor's Chrome (dashboard and its four tabs, email settings, alerts, pack history, transaction history, trophy cases, trades, trade block, public profile, API keys, Top Shot Collection tab, three signed-in concierge questions); the 390 px and 320 px mobile sweeps (83 + 83 pages: every tab of every collection, one page per entity family, the main insights boards); the 13 live dashboard artifacts' queries; Search Console.

### Shipped (ledger entry 11-09 "second audit pass")

1. **Cost basis count** — the Top Shot Collection tab said "27 moments with a known cost" beside a $113,123 cost basis that `get_wallet_summary` had summed over 6,628 moments. The count was taken from the rows loaded on screen. It now uses the RPC's own `moments_with_cost`.
2. **Email settings said "RPC isn't sending it yet"** about a digest that has been sending since 11-02/03. Now: Monday morning, only in a week the value moved 5 % or more.
3. **Locked + Unlocked FMV exceeded Wallet FMV** ($54,437 + $2,981 vs $52,275) with nothing saying why: the split counts stale-priced moments, the headline leaves them out. A caption now says so when stale-priced moments exist.
4. **Candy ticker** claimed "every edition priced" and "FMV on every card" — false since the 11-08 catalogue widening (190 of ~22.8k priced). Reworded; a guard bans both phrases.
5. **Concierge** sent a cost-basis question to the dashboard Overview (it is on the Collection tab) and had nothing on the weekly email. Two `explain_ui_field` dictionary entries added with tests.
6. **Sentinel Edition Coverage (decided: option b)** — legacy Candy collections are their own scope (`sentinel_edition_coverage`, `20261110072431`), printed beside the headline. Live coverage reads 99.5 % (65,358 / 65,708); Candy legacy catalogue 1 / 21,736. Keyed on the SET, not on "has no price". A per-edition "never sold" scope was measured and rejected: 34.7 s, 464,805 buffers.
7. **Terms page** — Flowty replaced as the example third-party marketplace (decided).

### Decided, not changed

- **Candy "silent" status stays** on one $0.17 legacy sale; the revival arm stays breached as the reminder. A check is scheduled for 11-12 to count Candy sales by day and set.
- **No sitemap prune for legacy Candy editions** (21,961 `candy-mlb/edition` URLs, ~21.7k unpriced). It would be a real crawl-budget lever, but the 10-20 read found Panini's "thin" editions were the top organic surface, so pruning on a hunch is the wrong way round. Filed under #66 with the numbers below.

### Measured, clean

- **Mobile:** 0 horizontal overflow, 0 broken images, 0 console errors, 0 iOS-zoom inputs at either width. `/nba-top-shot/set/freshman-gems` served "Recent sales couldn't be loaded — refresh to try again" (an honest degraded panel).
- **Artifacts:** all 78 tables, views and functions the 13 live dashboards query exist.
- **Search Console (index data through 10-25; 28 d to 11-08):** 58 clicks / 2.01K impressions / position 12.4 (10-20: 41 clicks; 10-03: 9). Indexed 41.3K (43.6K on 10-20); not indexed 62.5K (28.8K): crawled-not-indexed 31,742, discovered-not-indexed 21,370, blocked by robots 4,715, alternate canonical 2,800, noindex 862, 404 539, redirect 349, dup-no-canonical 56, 5xx 19. The not-indexed growth is Google working through a sitemap that went from ~105K to 111,866 URLs.

### Queued for Trevor / Claude Code (additions)

8. **[P3, Trevor, new] The collection label "Candy MLB"** now sits over DC, Netflix, NASCAR and college-football pages (e.g. `/candy-mlb/team/university-of-maryland`, a "TEAM" page for a college). Renaming the label (the slug can stay) touches titles, the registry and many pinned tests; not done at midnight.
9. **[P4, Trevor] Two spent scheduled tasks could not be deleted from this session** ("Dapper + Flowty recovery check", "R133: retire ?token= admin arms") — the session's permission check refused those two; five others were deleted.
10. **[P4, Claude Code] `/trades` lists cancelled rooms with an "Open →" link and no way to clear them** (two cancelled, empty rooms on Trevor's list). Cosmetic.

### Post-deploy verification (11:48 PM – 11:58 PM PT)

- Live, by request: Terms (Magic Eden present, Flowty absent), Candy ticker, Email settings copy, and the concierge answering both new questions correctly from Trevor's signed-in session.
- The stale-priced caption renders on `/nba-top-shot/collection` for his wallet (headless, anonymous: Wallet FMV $52,274.62 · Unlocked $2,981.10 · Locked $54,437.02 · "locked + unlocked include the stale-priced").
- ⚠ **The cost-basis count was NOT seen on the rendered page.** It is an owner-only strip, and by 11:50 PM Trevor's Chrome had stopped painting (`requestAnimationFrame` did not fire in 4 s; display asleep), so every streamed Suspense page stayed on "Loading…" there — on Top Shot and All Day alike, which is what ruled out a regression. What was verified instead: `/api/wallet-summary` returns `moments_with_cost: 6628` for his wallet from his session, and the unit tests pin the count to that field. Worth one look at the Collection tab when he is next on the site: it should read "6,628 moments with a known cost".
- Small thing seen on the way: for the first ~3 s of an anonymous load the Locked FMV tile reads "n/a for this collection" on Top Shot before the summary arrives. Cosmetic, not fixed.
