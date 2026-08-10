# RPC deep-audit findings register

Persistent across monthly deep audits. **Purpose: never re-derive a settled question.**

How to use it: at the start of each deep audit, run only the one-line probe for each `VERIFIED-CLEAN` row. If it still returns the expected value, stamp the date and move on — do NOT re-audit that area. If a probe fails, that becomes a finding and earns a full investigation. Re-measure each `OPEN` item's evidence number and record whether it grew, shrank, or resolved.

Created 2026-08-09 (first deep-audit run).

⚠ **Probe hygiene, learned on run 1:** `select count(*) from check_secdef_anon_exec_drift()` returns **1** when the surface is CLEAN — the function returns a single row containing a JSON array, so `count(*)` counts the row, not the findings. Use `jsonb_array_length((select check_secdef_anon_exec_drift()))` and expect **0**. The count-based probe produces a false positive every time.

---

## OPEN

| id | first seen | sev | finding | current evidence (2026-08-09) | owner |
|---|---|---|---|---|---|
| D1 | 2026-08-09 | **P0** | Unauthenticated service-role write IDOR — `/api/support-chat/feedback` updates `support_conversations` by attacker-supplied `messageId` with no ownership check | route is anon-reachable (`proxy.ts:291`); 4,932 rows, sequential bigint PK; can overwrite `user_email`/`owner_key`/`user_wallet` on the 18 rows carrying a real email | Claude Code |
| D2 | 2026-08-09 | **P0** | 8 hardcoded cron gate keys (`rpc_pls_…`) committed to a **public** repo, sole auth on ingest/backfill/compute edge functions; also mirrored in ~9 committed docs | `grep -rn 'rpc_pls_' supabase/functions docs` → non-zero in both trees | Trevor (secrets) |
| D3 | 2026-08-09 | **P0** | `/nba-top-shot/sets` renders a raw DB error to end users: `ERROR / canceling statement due to statement timeout` | adjudicated live in Chrome; flagship collection, Set Tracker promoted in the page ticker | Claude Code |
| D4 | 2026-08-09 | **P0** | TS Sniper shows `0 deals` by default while 200 exist — the default-on "VERIFIED FMV ONLY" filter empties the flagship board; Overview simultaneously advertises those deals | unchecking the box yields 200 deals | Claude Code |
| D5 | 2026-08-09 | **P0** | Homepage promises "buy / skip recommendations"; `/privacy` describes wallet-connect + purchases RPC executes; `/pricing` sells `/rewards`, which hard-404s; concierge denies two boards public since Jul 31 / Aug 1 | `HomePageMarketing.tsx:150`; `privacy/page.tsx:76,88`; `rewards/layout.tsx:14` vs `pricing/page.tsx:133`; `support-chat/route.ts:683,738` | Claude Code |
| D6 | 2026-08-09 | P1 | `drain-conflated-subeditions` dead 9 days — 504s at 300s `maxDuration` and logs **nothing** (no `pipeline_runs` row, invisible to `detect_stalled_pipelines`) | `pipeline_runs_daily` last row 2026-07-31; two 504s observed 20:30Z | Claude Code |
| D7 | 2026-08-09 | P1 | `stale-fmv-monitor` fails **40.8%** of ticks with zero observability — an FMV-staleness alarm that is itself down 2 ticks in 5 | 29×200 / 20×504 over 30h; no `log_pipeline_run` anywhere in the route | Claude Code |
| D8 | 2026-08-09 | P1 | wmc metadata denorm has **no self-heal** — the post-pass enrichment failure is only `console.warn`'d, never logged, and `skipCached` prevents recovery on the next walk | backlog repaired this run (56,898 → 197) but **will regenerate**: 47,305 of 47,498 AllDay rows were created within 7 days | Claude Code |
| D9 | 2026-08-09 | P1 | Sniper "net" figure has an inverted sign — `ASK $5.00 / FMV $5.00` renders `net +$0.25 after 5% fee`; ~199 of 200 rows are zero-spread, so the wrong figure dominates the board | zoom-confirmed on 2 rows | Claude Code |
| D10 | 2026-08-09 | P1 | `/nba-top-shot/series/series-4` 404s and the site links to it (Overview series list + `sitemap/0.xml`); series 1/2/3/5 all resolve | likely the on-chain-5 ↔ display-4 mapping | Claude Code |
| D11 | 2026-08-09 | P1 | AllDay overview intermittently renders false zeros (`TOTAL EDITIONS 0`, `PIPELINE UNKNOWN`); reload gives `6,190`. Timeout-renders-as-zero class | 1st load vs reload, same session | Claude Code |
| D12 | 2026-08-09 | P1 | `/nba-top-shot/analytics` contradicts the rest of the site: `ORDER BOOK DEPTH 1 listings`, `TOTAL VOLUME $0.00 / 0 sales` (30d) while Overview shows `$32,584` 24h; 7 panels blank with no degraded notice | adjudicated in Chrome | Claude Code |
| D13 | 2026-08-09 | P1 | Pinnacle FMV 23 days stale (`PIPELINE STATUS OUTDATED`) while the market is live (`$557` 24h). All 5 "cheapest asks" read exactly `$1` — check the uniform-$1 floor issue has not returned | page is honest about it; the daily `pinnacle-2.0.0-render` recompute appears dead | Claude Code |
| D14 | 2026-08-09 | P1 | 3 prod migrations have **no committed file and no ledger entry**, and the ledger asserts 2 of them were never shipped. Two redefine a **public** board MV | prod versions `20260809200134`, `20260809200600`, `20260809203055`; `docs/wrapup-2026-08-09-ledger-and-claudemd.md` holds the un-spliced entry | Claude Code |
| D15 | 2026-08-09 | P1 | `check_unmapped_backlog_growth()` blows the alert path under saturation — `check-alerts` fails **18.3%** (13/71 in 24h), so alerting is down exactly when it matters | inbox `2026-08-09T2110Z` reported 4 fails/6h; measured worse | Claude Code |
| D16 | 2026-08-09 | P1 | `candy-offers-indexer` abandons **33%** of sweeps on its own 700s deadline, leaving `candy_offers.is_active` stale on a **public** board | 8 fails / 24 runs (7d), `dur_max` 760,223 ms | Claude Code |
| D17 | 2026-08-09 | P2 | 4 Vercel cron routes at/over their Lambda ceiling: `allday-lock-refresh` max 310s vs 300 cap (47.5% fail), `candy-listings-indexer` 344s vs 300 | killed runs may log nothing, so recorded max is a **lower bound** | Claude Code |
| D18 | 2026-08-09 | P2 | 10 inert schedules: run on time, write nothing, for 7 straight days. `pinnacle-sales-history-backfill` burns **p95 237s × 62 ticks** for 0 rows on an IO-starved DB — cheapest saturation win available | see report §B-F11 | Claude Code |
| D19 | 2026-08-09 | P2 | ⚠ CLAUDE.md:54 justifies the UFC revival arm's `sold_at` keying on the premise that both UFC backfills "add ~200 historical rows/24h" — telemetry says **0 rows for 7 days**. Premise is stale either way | `pipeline_runs_daily` | Claude Code |
| D20 | 2026-08-09 | P2 | 299 sets collapse into merged entity pages with no disclosure (AllDay 220/363, TS 79/271). `draw-it-up` = 10 underlying sets / 117 editions, `set_name_variants` shows **1** | set-completion %, edition count and FMV totals all computed on the merged denominator | Claude Code |
| D21 | 2026-08-09 | P2 | AllDay `edition_offers` bids are a median **12.8 days** old while fresh AllDay offers live in `badge_editions` (0.8h). 4 consumers not verified collection-gated — **P1 if any is collection-agnostic** | 2,261 rows, median age 307h | Claude Code |
| D22 | 2026-08-09 | P2 | 4 prototype-key lookups reachable from a URL param. `/analytics/methodology/constructor` **hard-crashes** (`entry.paragraphs.map` on `Object.prototype.constructor`, bypassing `notFound()`) | `methodology/[topic]/page.tsx:43`; also `analytics/sales|loans/[collection]`, `alerts/suggest/route.ts:26` | Claude Code |
| D23 | 2026-08-09 | P2 | `TIER_ORDER` duplicated 4× and all copies drifted — 3 casings, both sort directions, `UNCOMMON` present in 1 of 4 | `analytics-fmv-dashboard-compute.ts:47`, `analytics-sets-dashboard-compute.ts:42`, `fast-break-client-compute.ts:25`, `trophy-picker-format.ts:22` | Claude Code |
| D24 | 2026-08-09 | P2 | 29 layouts emit a double-suffixed `<title>` — "… \| Rip Packs City \| Rip Packs City". All indexable; the 2 newest boards correctly opt out and document the bug | `grep -rn '^\s*title: ".*| Rip Packs City",' app --include=layout.tsx \| wc -l` → 29 | Claude Code |
| D25 | 2026-08-09 | P2 | 128 wmc rows render an impossible serial (e.g. "#500 / 499"); 34 are stale wmc denorm disagreeing with `editions`, 94 agree and are upstream-wrong | rate 128 / 2,209,817 = 0.006% | Claude Code |
| D26 | 2026-08-09 | P2 | 4 Top Shot players have duplicate rows sharing one slug, splitting each player's catalogue across two `player_id`s | `alexandre-sarr`, `alperen-eng-n`, `carlton-carrington`, `maya-caldwell` — 4/1,360 = 0.3% | Claude Code |
| D27 | 2026-08-09 | P2 | `/api/alerts/route.ts:63-73` is the textbook raw-`fmv_snapshots` + JS-dedupe + unbounded `.select()` anti-pattern. **Latent** — `fmv_alerts` has 0 rows; live the day it doesn't | 1000-row clamp covers ~11 editions at 87 snapshots/edition | Claude Code |
| D28 | 2026-08-09 | P2 | `sync-nba-projections` reports `all_upstreams_failed` (not the no-slate branch) 65.6% of runs, 0 rows in 7d. The 08-08 v9 split may be mis-classifying. ⚠ Do NOT retire — sole writer for `nba_games`, read by a live public team page | 40 fails / 61 runs (7d) | Claude Code |
| D29 | 2026-08-09 | P2 | `purge-stale-listings` 401s every Vercel cron tick (accepts only `INGEST_SECRET_TOKEN`; Vercel sends `CRON_SECRET`). Impact ~nil today — `cached_listings` is 303 rows, 1 older than 48h | exact recurrence of the removed `pinnacle-sync` class | Claude Code |
| D30 | 2026-08-09 | P2 | 3 components are production-dead (test-only importers): `InsiderSignals.tsx` (137 lines), `TierBreakdownCard.tsx`, `PortfolioSparkline.tsx`. ⚠ Deleting any requires removing its `check-brand-tokens.mjs` PROTECTED entry **in the same commit** | prod uses the different `components/analytics/InsiderSignals.tsx` | Claude Code |
| D31 | 2026-08-09 | P2 | Migration parity backlog grew: 14-day window now **223** prod rows with no committed file (was ~114 on 08-09); total prod 2,482 vs 402 committed files | blocks making `migration-parity.yml` enforcing | Claude Code |
| D32 | 2026-08-09 | P2 | 5 pipelines find rows and write none for 7 days: `topshot-onchain-art-backfill` (4,430/0), `topshot-subedition-circulation-backfill` (22,020/0), `match-topshot-players` (11,320/0), `pinnacle-listings-retry` (3,045/0), `pack-events-ingest-backfill` (45,237/0) | some are legitimately dedupe-only; the two `topshot-*-backfill` need one read of their write branch | Claude Code |
| D33 | 2026-08-09 | P2 | Candy MLB best-offer values look mis-attributed: offers far above floor ask (Jung Hoo Lee ask `$4.63` / offer `$57.85`), and identical values repeat across distinct editions (`$116` on four Murakami parallels) — signature of a collection- or player-level offer mapped onto every edition | on the **public** `/insights/candy-mlb` | Claude Code |
| D34 | 2026-08-09 | P2 | Pinnacle has no FMV confidence-share arm (sits at 29.7% HIGH+MED, untracked) because its FMV lives in `pinnacle_fmv_history` | `select count(*) from rpc_trust_health_precompute where metric like '%fmv_high_med_share%'` → 5, want 6 | Claude Code |
| D35 | 2026-08-09 | P2 | 4 rendered strings say "connect a wallet" / "connect yours" in a product with no connect surface | `WalletSoldMomentsView.tsx:150`, `WalletPacksView.tsx:191`, `my-teams/page.tsx:173`, `challenges/page.tsx:167` | Claude Code |
| D36 | 2026-08-09 | P2 | AllDay: 217 editions where `highest_offer > low_ask` (5.34%) vs TS 0.11% — a 50× ratio on the same code points at the AllDay offers lane. Median gap $1.00, max $115 | INFERRED benign timing skew, not proven | Claude Code |
| D37 | 2026-08-09 | P2 | AllDay `unmapped_sales` backlog growing: **94,852** unresolved (was 90,865 on 08-08, +3,987) | resolver never reaches the tail | Claude Code |
| D38 | 2026-08-09 | P2 | Doc drift: CLAUDE.md:54 says `ufc_fmv_pct_stale_30d` is "unaffected and still live" — it was **retired** `20260809145547`. CLAUDE.md:766 attributes 3 cron-job.org jobs to Vercel. CLAUDE.md:123 (19/16/3 workflows) contradicts :765 (20/17/3). `vercel.json` is **37** crons, doc says 36 | verified against live | Claude Code |

---

## RESOLVED

| id | resolved | finding | fix | revert path |
|---|---|---|---|---|
| D-R1 | 2026-08-09 | **56,898 wmc rows rendered a nameless, mintless moment while the name sat in `editions`** — 47,498 AllDay across 49 wallets + 9,400 Golazos in 1 wallet. Not missing data: 99.6%/100% resolved to an edition that HAS both a player name and a circulation count | Ran the existing pinned SECDEF `backfill_wmc_metadata_from_editions(wallet, collection)` per wallet (COALESCE fill-only, idempotent, no deletes) under `statement_timeout='240–290s'`. Verified 56,898 → **197**, and the 197 are fully explained: 59 have a NULL `edition_key`, 138 point at an edition that itself has no name. Golazos `mint_count` NULLs also went 9,400 → 0. Spot-checked filled values against `editions` — exact match | None needed — fill-only, no rows deleted, no schema change, no prior value overwritten. To re-null would require a manual UPDATE; there is no reason to |

---

## VERIFIED-CLEAN (re-probe cheaply, do not re-audit)

| area | last verified | one-line probe | expected |
|---|---|---|---|
| RLS coverage | 2026-08-09 | `select count(*) from pg_tables where schemaname='public' and rowsecurity=false` | `0` |
| Public security invariants | 2026-08-09 | `select count(*) from check_public_security_invariants()` | `0` |
| Anon write surface | 2026-08-09 | `select count(*) from check_anon_write_surface()` | `0` |
| SECDEF anon-exec drift | 2026-08-09 | `select jsonb_array_length((select check_secdef_anon_exec_drift()))` ⚠ **not** `count(*)` | `0` |
| Security advisors | 2026-08-09 | `get_advisors(security)` | 0 ERROR (7 WARN are the benign `*_security_definer_function_executable` class on 3 known fns) |
| Performance advisors | 2026-08-09 | `get_advisors(performance)` | 0 ERROR, 0 WARN |
| Staged Panini/Candy data is genuinely data-gated | 2026-08-09 | `count(*) filter (where has_table_privilege('anon',c.oid,'SELECT'))` over `relname like 'panini%' or 'candy%'` | 37 objects, **0** anon-readable |
| No anon-readable view bypasses RLS | 2026-08-09 | anon-readable `relkind='v'` whose `reloptions !~ 'security_invoker=(on\|true)'` | `[]` |
| No anon/auth-readable materialized views | 2026-08-09 | `relkind='m'` with anon or authenticated SELECT | `[]` — sharpest silent-leak class, empty |
| No anon-executable SECDEF function writes | 2026-08-09 | `prosecdef and has_function_privilege('anon',oid,'EXECUTE')`, grep `prosrc` for INSERT/UPDATE/DELETE | 4 grants / 3 fns, **none write** |
| No hardcoded credentials (JWT, `sb_secret_`, `sk-ant-`, `AKIA`, `ghp_`, `re_`, Telegram) | 2026-08-09 | grep those prefixes outside `node_modules` | **0 hits** (the 8 `rpc_pls_` gate keys are tracked separately as D2) |
| No secret leaked to logs or response bodies | 2026-08-09 | grep `NextResponse.json(…process.env…)`, `Object.fromEntries(req.headers)`, echoed `Authorization` | **0 hits**; only boolean-presence + length are logged |
| GitHub Actions secret handling | 2026-08-09 | 20 workflow files | all via `Bearer ${{ secrets.X }}` or `env:`; never in a URL, never echoed, no `set -x` |
| IDOR — the guarded majority | 2026-08-09 | ~60 routes | ownership enforced via session id / `.eq("user_id", user.id)` / `requireOwnedKey`; all 47 `admin/**` Bearer-gated; all 4 `breaks/[id]/**` token-gated |
| No PII in anon-readable surfaces | 2026-08-09 | scan the 77 anon-readable tables for email/phone/IP/token columns | **none**; exposure is deliberate public-profile + public-market data only |
| No stalled pipelines | 2026-08-09 | `select * from detect_stalled_pipelines()` | `[]` |
| Every pg_cron failure is the known self-recovering saturation class | 2026-08-09 | `check_pgcron_recent_failures()` | all errors are bare `statement timeout` on REFRESH MV / big INSERT…SELECT. **Any non-timeout error is a real finding** |
| Overall pipeline failure rate | 2026-08-09 | 24h agg on `pipeline_runs` | 2.20% (320/14,569); ~80% of fails are saturation-class |
| pg_cron has no disabled/orphan jobs | 2026-08-09 | `select count(*), count(*) filter (where active) from cron.job` | 80 / 80 |
| Vercel cron tick delivery (no cron-job.org-style dropout) | 2026-08-09 | ratio of `pipeline_runs_daily` runs to schedule-implied count | 95–112% across 15 jobs; only the 3 broken jobs show real loss |
| `evm-transfers-ingest` confirmed dead as documented | 2026-08-09 | `select max(day) from pipeline_runs_daily where pipeline='evm-transfers-ingest'` | `2026-08-02` |
| In-code TODO/FIXME backlog genuinely drained | 2026-08-09 | `grep -rn '\bTODO\b\|\bFIXME\b\|HACK:'` excl. node_modules/.next/docs | 6 hits, **0 actionable** (4 retrospective prose, 2 test names) |
| `.ilike` on an enum column | 2026-08-09 | `\.ilike\(\s*["'](confidence\|tier\|fmv_confidence\|liquidity_rating\|status)["']` | 3 hits, all on `cached_listings.tier` (plain text, not the enum) — clean |
| Batch `.insert()` swallowing 23505 | 2026-08-09 | grep `23505` in non-test code | every live batch site retries row-by-row; `backfill/route.ts:265` is single-row (N/A) |
| `rows.length` used as a PostgREST total | 2026-08-09 | `rows\.length\|data\.length\|total:\s*\w+\.length` over `app/api` | ~70 hits, all loop bounds / pagination sentinels — **0** substituted for a count |
| Unchunked `.in()` > 500 | 2026-08-09 | `\.in\("(edition_id\|external_id\|id)",\s*<ident>\)` | ~55 sites, substantially all chunked; 2 exceptions tracked in D27 |
| Brand tokens | 2026-08-09 | `node scripts/check-brand-tokens.mjs` | exit 0; every `#E03A2F` in a protected file is the sanctioned `var(--rpc-red, #E03A2F)` fallback or carries a `brand-exception` comment |
| `check-brand-tokens.mjs` references only existing files | 2026-08-09 | same script (exits 1 naming any missing file) | exit 0 — the 2026-08-08 5-commit CI landmine has not recurred |
| CI job set | 2026-08-09 | read `.github/workflows/ci.yml` | 8 jobs, **all blocking**, zero `continue-on-error`; thresholds match CLAUDE.md exactly (primary 89.3/75.1/91.5/91.6, component 78.6/66.4/78.2/82.6) |
| Both launched boards are indexable + route-open + sitemapped | 2026-08-09 | `grep -n "CANDY_MLB_PUBLIC\|PANINI_PUBLIC" proxy.ts lib/sitemap-data.ts` | flags `true`, gates are `!FLAG && …`, both slugs in sitemap, neither noindex |
| Canonical tag on every insights board | 2026-08-09 | `grep -rLn canonical app/insights --include=layout.tsx` | empty (31/31 have it) |
| Anon first-run CTA is identifier-only | 2026-08-09 | `grep -n "placeholder =" components/WalletSearch.tsx` | "Top Shot username, 0x wallet, or moment ID"; no connect surface anywhere |
| No cart / gifting / trading in rendered copy | 2026-08-09 | `grep -rn "add to cart\|trade-hub\|/api/gift" app components --include=*.tsx` | 0 hits |
| Zero/negative FMV | 2026-08-09 | `count(*) filter (where fmv_usd<=0)` on `fmv_current` + `pinnacle_fmv_history` | `0` everywhere |
| `circulation_count = 0`, impossible jersey, `drop_weight > orig_drop_weight`, negative pack EV, `fmv_sanity_flags`, `sales_serial_supply_worst_pct`, `topshot_impossible_parallel_serials`, subedition without a name | 2026-08-09 | see report §C-10 | **0** on every one |
| TS parallel conflation rate stable | 2026-08-09 | parallel share of canonical TS editions | 3,670/13,106 = **28.0%** (CLAUDE.md says ~27.9% — current) |
| Golazos `edition_offers` still absent (honest gap, not fabricated) | 2026-08-09 | `select count(*) from edition_offers where collection_id='06248cc4-…'` | `0` |
| AllDay + Golazos pack pools never decremented — **honest gap, not a defect** | 2026-08-09 | `count(*) filter (where drop_weight = orig_drop_weight)` by collection | AllDay 89,783/89,783, Golazos 1,957/1,957 — no upstream feed exists |
| Golazos badge `updated_at` median 363h is **not** staleness | 2026-08-09 | — | `refresh_golazos_badge_low_ask()` uses `IS DISTINCT FROM`, so it is a last-**changed** stamp. Do not "fix"; never render it as "updated N days ago" |
| Candy MLB wmc is the reference implementation | 2026-08-09 | NULL rates by column | 0 NULLs on every column, 0 fossils, 25,375 rows = supply exactly |

---

## NOT-A-FINDING (healthy by design — do not re-raise)

| item | why | probe |
|---|---|---|
| UFC 1,654h FMV staleness / 0% HIGH+MED | Market closed May 2026. `ufc_fmv_pct_stale_30d` correctly loud (96.3) | — |
| Golazos 0.35% HIGH+MED | Thin market, matches CLAUDE.md | — |
| 1,221 editions with `jersey_number > circulation_count` | A player wearing #23 on a 10-mint edition has no reachable jersey-match serial; the chip correctly never fires | — |
| Pinnacle 72.3% NULL serial in wmc | Pinnacle has unserialized editions by design (`edition_type`) | — |
| `special_serial_holders` holding only 25 rows | Legacy table; the live board is wmc-backed per CLAUDE.md. Not a collapsed pipeline | — |
| `ufc-sales-indexer` writing 0 rows | Correct — market closed. The revival detector is the right instrument | — |
| `ownership-sync-dune` running once a week | By design (free Dune credit tier) | — |
| `sales-seller-recovery-dune` inert | Documented — missing `DUNE_SALES_SELLER_QUERY_ID` | — |
| `/api/cron/warm` not writing `pipeline_runs` | Deliberate (`route.ts:16`) — "a warmer is not a data pipeline". Only the 33× 504 rate is the finding (D-adjacent) | — |
| `fmtUsd` 9 variants, serial-multiplier 2 copies, `computeDualPrice` lib↔Deno | Duplication done **right** — documented consolidation decision / pinned by cross-agreement tests | — |
| `acquisition-stats` `SLUG_TO_DB_SLUG[input] ?? input` prototype key | Value only reaches `.eq("slug", …)`, matches nothing, falls back to the TS collection id. Identical to any unknown slug | — |
| TS headline confidence share appearing to fall 54.9 → 46.6 | **Measurement artifact.** Per-day repriced cohort oscillates 55.8–71.0 over 7 days with no trend. Quote a 7-day mean, never a single reading | per-day cohort query in report §C-1 |

---

## DECLINED — do not re-suggest
*(Trevor's section — only he edits this.)*
