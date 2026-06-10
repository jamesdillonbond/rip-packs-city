# All-user FMV + badge accuracy audit — 2026-06-09

**Trigger:** collector complaints that RPC FMV is bad; Trevor's S1 Jokić showing a wildly wrong value; badge coverage "extremely poor."

**Scope:** all 24 active allow-list users (23 with TS holdings). Per user: top 100 moments by current RPC FMV (2,300 rows, 1,201 distinct editions) captured to scratch table `audit_lt_user_top100`, cross-checked against live `fmv_snapshots`, `sales`, `badge_editions`, and dapper.market. LiveToken per-serial comparison: **blocked tonight — LiveToken's portfolio/listings backend was unresponsive for 35+ min (every portfolio API request hung "pending"; even their GA beacons 503'd)**. The capture harness (scratch tables + extraction method) is ready; re-run when their backend recovers. Everything below is verified from RPC's own data + dapper.market ground truth.

---

## Headline

Of the **$823,720** total top-100 displayed value across all users, **$534,760 (65%)** sits in the two broken pricing classes below. The errors concentrate exactly where users look first — bad values sort to the **top** of every portfolio. Platform-wide only ~1.6% of actively-traded editions are badly mispriced (63 of 4,971 with 5+ sales are >3× their own sales median; 15 are >10×; 19 are <⅓×) — but portfolio-top selection makes it feel like everything is wrong.

## Failure class 1 — thin-window grail-serial spike (the S1 Jokić)

Edition **2:202** (Jokić Base Set S1, circ 3,525) was **$8.60 MEDIUM** on 06-05. By 06-06 the 30-day sales window had rolled down to ~2 sales: $6 (#568) and **$9,000 for serial #1** (05-09). fmv-recalc 1.7.0 let the grail-serial sale own the edition price → **$9,000 LOW**, re-stamped daily since.

- Blast radius: **2:202 alone is the #1 "most valuable" moment in 9 of 23 user portfolios** (common S1 edition everyone holds).
- The same class platform-wide (latest FMV ≥5× its own 30d median FMV, >$50): **18 spiked editions** among the 1,201 audited; 3 cratered.
- No serial-aware outlier rejection exists when the window is thin (n≤2 can't be outlier-filtered).
- Secondary find: 2:202's sale history is **bimodal** ($5–12 and $189–259 in the same weeks, overlapping serial ranges). The $200 cluster matches sibling edition **2:37**'s price level (low_ask $197.99, avg sale $1,058). Possible sales→edition mis-attribution; needs tx-level verification. Flagged, not yet proven.

## Failure class 2 — ask-based (ASK_ONLY) pricing overriding real sales

Mechanism caught live on **102:3519 (Fit Check, circ 250)**: $4.25 LOW until 06-06 → `topshot-gql-v1_haircut` (topshot-fmv-populate, marketplace-ask feed) stamped **$550 ASK_ONLY** from a troll ask on 06-07 → 1.7.0's stale-touch carried $550 forward daily (Step 6 re-stamps anything ≠ NO_DATA).

- In users' top-100s: 275 distinct ASK_ONLY editions; of the 58 with 90d sales, **21 are >3× the median sale, 16 >10×** (Clamps 98:3140 $274.45 vs $2.40 real, 6 wallets; De'Aaron Fox Honors $385 vs $7.65; Fit Checks at $54–550 vs $4–50).
- Platform-wide: 993 ASK_ONLY latest snapshots; 37 have 3+ sales in 90d; 9 are >3× and 8 >10× over the sales median. Small absolute count — but they sort to portfolio tops.
- 217 of the 275 audited ASK_ONLY editions have **zero** 90d sales (zero-sale grails: Cosmics, Holos, Anthologies, All-Star Classics at $1,665–$8,999 = ask×0.9). These are *unverifiable* in-house; LiveToken/market check pending. Known prior finding: ASK_ONLY realizes ~0.75, and the 06-07 TS-NO_DATA-troll-asks decision deliberately keeps zero-sale editions off ASK_ONLY via badge low_ask — but the **topshot-gql-v1 marketplace feed path has no such guard and no sales-precedence check**.

## Failure class 3 — display-layer drift (wmc denorm)

**518 of 2,300 rows (22.5%)** display a `wallet_moments_cache.fmv_usd` >±25% off the edition's live latest snapshot. Trevor's own wallet shows the same edition (2:202) at **$9,000 on one copy and $3.30 on another**. The wmc-fmv-populate denorm loop leaves rows stale for long stretches, so users see internally inconsistent numbers RPC never actually computed as current.

## Failure class 4 — badges: coverage, not classification

- `badge_editions` covers **3,138 of 9,136** canonical TS editions (**34%**).
- **593 of the 1,201** distinct editions in users' top-100s (49%) have **no badge row at all**; per-wallet "no badge data" rates on top-100 rows run 11%→99% (drv25: 99/100).
- Root cause: `/api/badge-sync` sources from **`searchMarketplaceEditions`** (marketplace search by badge-tag ID, paged, capped MAX_PAGES=80). It can only ever see editions the *marketplace search* returns — i.e. marketplace-active editions. Two-thirds of the canonical catalog (incl. older/unlisted editions, which is most of what collectors hold) never gets a row.
- Accuracy of what exists looks structurally fine (play_tags allowlist from the 2026-05-24 fix is in place; zero covered editions have empty tag arrays). The complaint "badges are missing/wrong" is overwhelmingly **missing**, not mis-classified. LiveToken badge-code comparison still pending for the accuracy half.

## Failure class 5 — circulation counts don't track burns

dapper.market link verification (5/5 sampled links resolve and match player/set/serial/owner exactly — the dual-link ship is sound):

| Moment | RPC circ | dapper.market LE |
|---|---|---|
| Clamps 98:3140 #70 | **1500** | **/1125** |
| Cooper Flagg 219:7408 #167 | **1149** | **/1000** |
| Jokić 2:202 #1097 | 3525 | /3525 ✓ |
| Harden 12:157 #2 | 25 | /25 ✓ |
| Clingan 176:7003 #1 | (null in wmc) | /1 (1-of-1) ✓ |

`editions.circulation_count` is mint-time and never decremented for burns. `badge_editions.burned/effective_supply` has the truth — but only for the 34% covered. Displayed "#x/y" is wrong wherever burns happened.

Also: team-moment editions (Clamps, Fit Check) have `player_name` NULL/empty — Dapper titles them by team ("Miami Heat Reel"). RPC renders blank player names on these.

## What checked out (not bugs)

- **Wemby MGLE 166:5978 "crater"** ($949→$114): honest repricing on 3 real sales ($95/$111/$135). Market fell.
- **LeBron MGLE 5:133 $1,955 LOW** (28 rows in one top-100): 3 sales in 90d, median $1,999, max $2,300. Correct.
- **Flagg Rookie Debut $372.58 HIGH**: low_ask $227, avg sale $214 — somewhat rich but in-market.
- dapper.market URL scheme + owner attribution: exact.

## Fix plan (priority order)

1. **Serial/outlier guard on thin windows (kills the Jokić class).** In fmv-recalc: when the 30d window has <N (e.g. 5) sales, (a) widen the window instead of pricing from what's left, and (b) cap any single-sale influence vs the edition's own trailing median (e.g. reject sales >5× trailing 90d median from WAP, or use the 90d median when 30d n<3). Serial-#1/jersey sales must never set edition FMV. *FMV-writer logic change → handoff to Claude Code for review per fmv-pipeline-patch-restraint.*
2. **Sales-precedence guard on the ask path (kills the Fit Check class).** topshot-fmv-populate (topshot-gql-v1) must not write ASK_ONLY over an edition with ≥3 sales in 90d; and clamp ask-derived FMV to ≤ k× trailing sales median when sales exist. Same guard fmv-recalc Step 5b already half-has via the troll-ask decision — the marketplace-feed path bypasses it.
3. **Stop Step 6 stale-touch perpetuating ASK_ONLY/poisoned LOW** — re-stamping should not refresh `computed_at` on ask-derived or single-sale snapshots (it makes poison immortal and hides staleness).
4. **One-time repair migration:** recompute/delete the latest poisoned snapshots for the identified editions (2:202 + the 18 spiked + the 9–16 ask-over-sales editions) so portfolios heal immediately. Bounded DELETE of latest bad snapshot per edition → next recalc tick reprices. (I can ship the data fix; the logic fixes are CC's.)
5. **wmc denorm tightening:** wmc-fmv-populate should prioritize wallets' high-FMV rows or run a drift-sweep (rewrite rows where |wmc−latest|>25%) so two copies of one edition never show different values. Mind the DBSAT/wmc-rewrite-storm constraint — drift-sweep, not full rewrite.
6. **Badge coverage:** badge-sync needs a catalog-walk mode (iterate canonical editions / sets via GQL `searchEditions` or per-set queries) instead of marketplace-search-only; target 9,136/9,136 with play_tags + circulations. This also fixes burns (write `burned`/`effective_supply` everywhere) → fixes Class 5 display.
7. **Display honesty (fast, frontend):** portfolio/dashboard top-N should down-rank or caveat ASK_ONLY/LOW/single-sale values ("ask-based — no recent sales"); never let an ask-derived number silently crown a portfolio.
8. **Team moments:** render team name when player_name is null (data exists in `team_name`/edition name).

## Pending / blocked

- **LiveToken per-serial FMV + badge-code comparison for all 23 wallets** — their backend was down during this audit. Harness ready: scratch tables `audit_lt_user_top100` / `audit_lt_livetoken_rows`, extraction method in memory `livetoken-rpc-audit-reference`. Re-run on recovery (scheduled retry created).
- 2:202 bimodal sales — tx-level verification of possible 2:37→2:202 mis-attribution.
- Scratch tables are RLS-on/service-role-only; drop with `DROP TABLE audit_lt_user_top100, audit_lt_livetoken_rows;` when the LiveToken leg closes.

## Shipped (2026-06-10 follow-through)

- **Repair pass 1** — `audit_20260609_repair_portfolio_top_poisoned_fmv`: 41 editions re-snapshotted to recency-aware, dust- and impossible-serial-filtered sales medians (algo `audit-repair-2026-06-09`). Verified 41/41 latest. Revert: `DELETE FROM fmv_snapshots WHERE algo_version='audit-repair-2026-06-09';`
- **Repair pass 2** — `audit_20260610_repair_pass2_anchor_to_live_book`: 26 editions anchored to the live TS book (19 down to ask×0.9 as ASK_ONLY, 7 up to corroborated last-sale/ask as LOW; algo `audit-repair-2026-06-10-anchor`). Trigger: pass 1 over-corrected S1 editions whose recorded cheap sales contradict their live book (2:244 LeBron $2 vs $23 floor; 11:151 $31.50 vs $499 floor+print) — more evidence for the mis-attribution investigation. Revert: `DELETE FROM fmv_snapshots WHERE algo_version='audit-repair-2026-06-10-anchor';`
- **dapper.market live-book verification (3/3 exact):** Tatum Honors 149:5378 floor $19 (=badge low_ask; old FMV $824.45 → $17.10); LeBron Throwdowns 11:151 floor $499/$529 (→$499); LeBron Base 2:244 floor $22.40/$23 (→$23). The Jokić 2:202 book floor $5.30-14 confirms its $6.00 repair (and confirms the April $189-259 "sales" cluster as pollution).
- **wmc drift-sweep** — `audit_20260609/10_wmc_drift_sweep_chunk1-5b` + `audit_20260610_wmc_sync_repaired_editions`: all 23 user wallets, 145,952 rows checked, **0 still drifted**; Trevor's two 2:202 copies both read $6.00.
- **Writer fixes + badge catalog-walk + display fixes + tree cleanup** → [docs/handoff-2026-06-10-fmv-badge-audit-fixes.md](../handoff-2026-06-10-fmv-badge-audit-fixes.md) (Claude Code, Items 0-7) — **DONE 2026-06-10** (commit `e3aee28` + 4 MCP migrations, deploy READY + health-verified). Item 1 grail guard + 90d thin-window extension; Item 3 Step 6 HIGH/MEDIUM-only re-stamp; Item 2 `upsert_topshot_marketplace_fmv` sales-precedence + 3×-median clamp + troll-ask gate + writes `top_shot_ask`; Item 4 `?mode=catalog` cursored badge sweep; Item 5 `refresh_wmc_fmv_drift_active` (allow_list-scoped); Item 6 wmc team_name fallback (display caveat/effective-supply deferred). See the ledger Shipped block for full revert paths + operator follow-ups (wire the `?mode=catalog` cron).
- **Item 7 — mis-attribution DISPROVEN (read-only, 2026-06-10).** The canonical `moments` table shows **0** sales mapping to a different edition across every suspect edition (2:202, 2:244, 2:2, 11:151, 11:153). The audit's "bimodal" / "below-book" clusters are real, correctly-keyed sales — market dispersion (temporal + serial-premium) plus the normal ask-vs-sales gap. The earlier "matches sibling 2:37's level" read was a hypothesis the per-nft check refutes (every $180–259 2:202 sale's nft_id maps to 2:202 with matching serial; the $9,000 nft 1143 is 2:202 serial #1). The UUID-dupe-merge contamination fear did not materialize here. The writer guards (Items 1–3) correctly contain the impact, so **no re-key migration is needed.** (The high "maps elsewhere" counts in the first pass were `IS DISTINCT FROM` treating un-hydrated nft_ids' NULL moment rows as "elsewhere".)
- **LiveToken leg** → scheduled task `rpc-livetoken-crosscheck-resume` (2026-06-10 09:00 PT).

## Verification trail

All numbers re-queried live during the audit (project bxcqstmqfzmuolpuynti): user set from `allow_list` (24 active); top-100 capture 2,300 rows/23 wallets; snapshot histories for 2:202, 102:3519, 166:5978; sales windows for 2:202 (the $9,000 serial-#1 sale, tx `ce1d66ec…`), 5:133, 166:5978; platform-wide counts as quoted. dapper.market checks: moments 425998, 38780336, 50259800, 770852, 49744949 loaded live in Chrome 2026-06-09 ~22:00 PT.
