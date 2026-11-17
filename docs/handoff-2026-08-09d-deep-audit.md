# Handoff — monthly deep audit 2026-08-09

Source: `docs/audits/deep-audit-2026-08-09.md`. Full evidence + per-item re-probes: `docs/audits/deep-audit-register.md` (ids D1–D38).

**Why this is a handoff and not shipped work:** the Cowork shell was down (`useradd … /sessions no space`, third consecutive run), so no git, no CI, no deploy. One DB-side fix was shipped and verified (wmc denorm 56,898 → 197). Everything below needs a push.

⚠ **Re-verify before acting.** These were measured 2026-08-09 16:30–18:00 PT during an active disk-IO saturation window, and concurrent sessions ship to this repo. Every item carries its probe — run it first. Several ledger claims were already stale when this audit checked them.

---

## P0 — do these first

### 1. Unauthenticated service-role write IDOR — `/api/support-chat/feedback` (D1)

`app/api/support-chat/feedback/route.ts:16-19` builds a **service-role** client named `supabase` (the documented naming trap). `:73-77` then does `.update({feedback, ...identityPatch}).eq("id", messageId)` where `messageId` comes straight from the request body, with **no ownership check**. The route is anon-reachable via `proxy.ts:291`.

Blast radius, measured: `support_conversations` = 4,932 rows, PK is a sequential `bigint` (no guessing). Anonymous → flip `feedback` on any row. Signed-in (anyone — the front door is open) → additionally overwrite `user_email` / `owner_key` / `user_wallet`, destroying attribution on the **18 rows that carry a real email**; those feed `beta_feedback_inbox` and the admin console. No read disclosure. Bounded only by the 60/min/IP limiter.

Fix: verify the caller owns the row (session/`owner_key`) before the update, or scope the `.eq` by the derived identity. `deriveIdentity()` is already called — its result is written *into* the row but never compared against it.

⚠ **Second bug in the same file, found en route: feedback-with-a-comment has never persisted.** `:61` builds `feedbackValue` as `"up: <comment>"`, but the column carries `CHECK (feedback = ANY(ARRAY['up','down']))`, so any comment path 500s. That code path is dead — decide whether comments should live in their own column.

*Probe:* `grep -n 'eq("id", messageId)' app/api/support-chat/feedback/route.ts` → should not match once fixed.

### 2. Eight hardcoded cron gate keys in a PUBLIC repo (D2) — **Trevor, secrets**

`const GATE = "rpc_pls_…"` enforced as the **sole** auth on 8 edge functions:

`ingest-allday-pack-opens:41` · `ingest-topshot-pack-opens-history:73` · `ingest-pinnacle-mints:27` · `compute-pinnacle-pack-ev:53` · `compute-golazos-pack-ev:30` · `backfill-topshot-pack-supply:23` · `backfill-pack-opens-api:32` · `backfill-allday-pack-supply:20`

The repo is public, so these are world-readable, and they gate ingest/backfill/compute against prod — on a disk-IO-starved instance that is a cheap throttling lever as much as a data-integrity one.

⚠ **The same values are mirrored in ~9 committed docs** (`docs/overnight/ledger.md` ×4, three handoffs, two archived). **Rotation must sweep `docs/` in the same pass or the new key leaks the same day.** Move to `Deno.env.get(...)`.

⚠ **Unverified and it changes the remedy:** whether these are still reachable in git history. The 2026-08-03 `filter-repo` purge rewrote history for a *different* secret; `docs/handoff-2026-08-02-open-items.md:77` asserts these remain. The shell was down so I could not run `git log -S`. **Check before deciding rotation is sufficient.**

*Probe:* `grep -rn 'rpc_pls_' supabase/functions docs | wc -l` → expect 0.

### 3. `/nba-top-shot/sets` renders a raw Postgres error (D3)

After ~30s of skeletons the flagship Set Tracker shows `ERROR / canceling statement due to statement timeout`. Two defects: the page is dead, and it leaks internal DB text to end users. The Set Tracker is promoted in the collection ticker. Adjudicated live in Chrome.

Related and probably the same root cause — **D20**: 299 sets collapse into merged entity pages (AllDay 220/363, TS 79/271) because `get_set_detail` keys on the name-slug against `sets_summary`. `draw-it-up` = **10 underlying sets, 117 editions**, and `set_name_variants` reports **1** variant, so the page has no signal it spans 10 seasons. Set-completion %, edition count and FMV totals are all computed on the merged denominator.

### 4. TS Sniper shows 0 deals by default while 200 exist (D4)

The default-on "VERIFIED FMV ONLY" checkbox empties the flagship Sniper: `0 deals · 0 hot · avg 0.0% off`. Unchecking yields **200 deals**. Meanwhile `/nba-top-shot/overview` advertises "TOP 5 SNIPER DEALS" with real discounts — the same collection contradicts itself in two tabs.

⚠ **D9, same board:** the "net" figure has an **inverted sign**. `ASK $5.00 · ADJ. FMV $5.00 · DISCOUNT -0%` renders `net +$0.25 after 5% fee`; a 5% fee on $5.00 is $0.25 *lost*. ~199 of the 200 rows are zero-spread, so the wrong number dominates the board. Fix both together.

### 5. Four user-facing claims the product no longer honours (D5)

| where | claim | reality |
|---|---|---|
| `components/HomePageMarketing.tsx:150` | "with **buy / skip recommendations**" | the concierge prompt explicitly bans buy/sell recommendations (`support-chat/route.ts:713-721`); RPC ships EV *verdicts* |
| `app/privacy/page.tsx:76-79, 88-90` | "if you **connect a Flow wallet**"; "moment **purchases initiated through** RPC execute on Dapper's or **Flowty's** infrastructure" | wallet sign-in deleted 2026-08-08; cart deleted 2026-08-01; Flowty's marketplace closed May 2026. **This is the legal page.** |
| `app/pricing/page.tsx:133` | "Rewards: earn Status + Credits and redeem them in the shop" | `app/rewards/layout.tsx:14` calls `notFound()` unconditionally. `/pricing` is public and sitemapped; the concierge repeats it at `:794-795` |
| `app/api/support-chat/route.ts:683, 738` | Panini and Candy "are NOT public yet" | both flags `true` since Jul 31 / Aug 1; `:793`'s board list omits both, so the assistant cannot surface them even when asked |

⚠ **D35, same class:** four rendered strings still say "connect a wallet" / "or connect yours" — `WalletSoldMomentsView.tsx:150`, `WalletPacksView.tsx:191`, `my-teams/page.tsx:173`, `challenges/page.tsx:167`. The correct verb is *search / paste an identifier*, which `WalletSearch.tsx:90` already uses.

⚠ **D9 note:** the concierge also contradicts itself on the signup model — `:667` says "no invite needed" (correct), `:799` says "invite beta" (stale).

---

## P1 — observability and silently-degraded surfaces

**D8 · wmc denorm has no self-heal — the repair I shipped will decay.** 47,305 of 47,498 AllDay rows were created within 7 days. Root cause is code-side: `lib/wallet-backfill-helpers.ts:1009` only `console.warn`s the post-pass failure. Two parts: (a) write that failure to `pipeline_runs` so it stops being invisible; (b) a periodic unscoped sweep — **but read the measurement first.** Plain `EXPLAIN` on the unscoped fill: **cost 131,420, seq-scan-bound on wmc** (126,991 = full scan of 2.2M rows), paid every run regardless of match count. ⚠ **The obvious partial index on `player_name IS NULL` is the WRONG fix** — partial-index predicates block HOT exactly like keys, and wmc write amplification was only just closed on 08-09. Needs a real decision, not a reflex index.

**D6 · `drain-conflated-subeditions` dead 9 days, logs nothing.** 504s at its 300s `maxDuration`; zero `pipeline_runs` rows; `pipeline_runs_daily` last row 2026-07-31. The route documented its own decay at `route.ts:92`. Textbook "killed at maxDuration logs NOTHING" — invisible to `detect_stalled_pipelines()`. Chunk it or raise the budget, and add a heartbeat so the next silence isn't 9 days. **D10 (`topshot-misattrib-drain`, 83% fail, silent since 08-07) is likely the same shape.**

**D7 · `stale-fmv-monitor` fails 40.8% with zero observability.** 29×200 / 20×504 over 30h, `maxDuration = 30`, and the route contains **no `log_pipeline_run` at all** — an FMV-staleness alarm that is itself down 2 ticks in 5 and says nothing. Same idempotent-cron class as the 08-08 `price-snapshots` 15→60 and `sentinel` 60→180 fixes.

**D15 · the alert path dies under saturation.** `check-alerts` fails **18.3%** (13/71 in 24h; the inbox reported 4/6h — it is worse than filed). Both it and `rpc_ops_snapshot()` die inside `check_unmapped_backlog_growth()`, which does a heavy unmapped scan on every call. Memoize it or bound it to an indexed window.

**D16 · `candy-offers-indexer` abandons 33% of sweeps** on its own 700s deadline (8/24 in 7d, `dur_max` 760s), leaving `candy_offers.is_active` stale on the **public** `/insights/candy-mlb` Spread tab. The guard is behaving correctly — the sweep no longer fits its budget. Workload growth, not saturation: it walked 72/72 bidders and still ran out.

**D11 · AllDay overview renders false zeros intermittently** (`TOTAL EDITIONS 0`, `PIPELINE UNKNOWN`; reload gives 6,190). Timeout-renders-as-zero — a visitor sees "this collection has no editions". **The same shape appears on `/dashboard`** (`TOTAL MOMENTS 0` while the Trophy Case above renders six real moments up to $2,880) — one observation, not re-probed.

**D12 · `/nba-top-shot/analytics` contradicts the rest of the site.** `ORDER BOOK DEPTH 1 listings` / `TOTAL VOLUME $0.00 / 0 sales` (30d) while Overview reports `$32,584` in 24h and Market lists 500 editions. Seven panels blank with **no degraded notice**. The "on-chain data only" disclosure may explain the zeros; it does not explain "1 listings".

**D13 · Pinnacle FMV 23 days stale** while the market is live ($557/24h) — the daily `pinnacle-2.0.0-render` recompute appears dead. Page is honest about it. Also: all five "cheapest asks" read exactly `$1` — check the documented uniform-$1 Flowty floor issue has not returned.

**D14 · 3 prod migrations with no committed file and no ledger entry**, two of them redefining the **public** `mv_topshot_perfect_mint_premiums_board`: `20260809200134`, `20260809200600`, `20260809203055`. The ledger asserts two were never shipped; prod disagrees. `docs/wrapup-2026-08-09-ledger-and-claudemd.md` holds the un-spliced entry. Recovery is lossless — `supabase_migrations.schema_migrations.statements` holds the exact applied body; md5-verify rather than retyping. This also means **the "3-day parity window is clean" precondition for making `migration-parity.yml` enforcing is no longer met** (D31: 14-day backlog now 223, was ~114).

---

## P2 — worth a batch pass

- **D22 · `/analytics/methodology/constructor` hard-crashes.** `METHODOLOGY[topic]` resolves `Object.prototype.constructor` → truthy → `notFound()` never fires → `entry.paragraphs.map` throws. Same class as the fixed `/constructor/sniper`. Auth-gated, but the front door is open. Three siblings render garbage rather than crashing: `analytics/sales/[collection]:93`, `analytics/loans/[collection]:83,98`, `alerts/suggest/route.ts:26`. Fix with `ownLookup`.
- **D17 · 4 cron routes at/over their Lambda ceiling** — `allday-lock-refresh` max 310s vs 300 cap (47.5% fail), `candy-listings-indexer` 344s vs 300. Killed runs may log nothing, so the recorded max is a lower bound.
- **D18 · 10 inert schedules** run on time and write nothing for 7 days. **`pinnacle-sales-history-backfill` is the cheapest saturation win available: p95 237s × 62 ticks for 0 rows** on an IO-starved DB.
- **D19 · ⚠ CLAUDE.md:54's premise is falsified.** It justifies keying the UFC revival arm on `sold_at` because both UFC backfills "add ~200 historical rows/24h" — telemetry says **0 rows for 7 straight days**. Either the premise is stale (arm can be simplified) or both backfills broke without failing. Worth one bounded check.
- **D21 · AllDay `edition_offers` median 12.8 days stale** while fresh AllDay offers live in `badge_editions` (0.8h, 99.9% coverage). Four consumers (`edition/[slug]`, `/api/best-offers`, `insights/deals`, `insights/offer-spread`) were **not verified collection-gated** — **this is P1 if any is collection-agnostic.** Trace that first.
- **D33 · Candy MLB best-offers look mis-attributed on a public board** — offers far above floor ask (ask `$4.63` / offer `$57.85`) and identical values repeating across distinct editions (`$116` on four Murakami parallels). Signature of a collection- or player-level offer mapped onto every edition.
- **D36 · AllDay has 217 editions where `highest_offer > low_ask`** (5.34%) vs TS 0.11%. The **50× ratio on shared code** is the signal, pointing at the AllDay offers lane. Median gap $1.00 (consistent with timing skew), max $115 (not).
- **D23 · `TIER_ORDER` duplicated 4× and all drifted** — 3 casings, both sort directions, `UNCOMMON` in 1 of 4. Copying a comparator between them silently reorders or drops a tier.
- **D24 · 29 layouts double-suffix the `<title>`** ("… | Rip Packs City | Rip Packs City"), all indexable. The 2 newest boards correctly opt out with `title: {absolute}` and document the bug — so it is known, unfixed, and now the majority case.
- **D26 · 4 TS players have duplicate rows sharing a slug**, splitting each catalogue across two `player_id`s.
- **D25 · 128 wmc rows show an impossible serial** ("#500 / 499"); 34 are stale denorm vs `editions`, 94 are upstream-wrong. Rate 0.006%.
- **D10 · `/nba-top-shot/series/series-4` 404s** and the site links to it (Overview series list + `sitemap/0.xml`); 1/2/3/5 resolve. Likely the on-chain-5 ↔ display-4 mapping.
- **D27 · `app/api/alerts/route.ts:63-73`** is the raw-`fmv_snapshots` + JS-dedupe + unbounded `.select()` anti-pattern. **Latent — `fmv_alerts` has 0 rows.** Fix before that changes.
- **D30 · 3 production-dead components** (test-only importers): `components/InsiderSignals.tsx`, `profile/TierBreakdownCard.tsx`, `profile/PortfolioSparkline.tsx`. ⚠ **Deleting any requires removing its `check-brand-tokens.mjs` PROTECTED entry in the same commit** — that guard fails on a missing file and caused the 5-commit CI outage on 08-08.
- **D34 · Pinnacle has no FMV confidence-share arm** (29.7% HIGH+MED, untracked) because its FMV lives in `pinnacle_fmv_history`.
- **D28 · `sync-nba-projections`** reports `all_upstreams_failed` (not no-slate) on 65.6% of runs with 0 rows in 7d — the 08-08 v9 split may be mis-classifying. ⚠ **Do not retire it** — sole writer for `nba_games`, read by a live public team page.
- **D29 · `purge-stale-listings` 401s every Vercel cron tick** (accepts only `INGEST_SECRET_TOKEN`). Exact recurrence of the removed `pinnacle-sync` class. **Impact ~nil today** — `cached_listings` is 303 rows with 1 older than 48h. One-word fix; do not escalate.
- **D32 · 5 pipelines find rows and write none** for 7 days. Some are legitimately dedupe-only; `topshot-onchain-art-backfill` (4,430/0) and `topshot-subedition-circulation-backfill` (22,020/0) need one read each of their write branch.
- **D38 · doc drift in CLAUDE.md:** `:54` says `ufc_fmv_pct_stale_30d` is "unaffected and still live" — it was **retired** (`20260809145547`). `:766` attributes 3 cron-job.org jobs (`refresh-pack-grail-metrics-mv`, `backfill-pack-rip-metadata`, `ownership-sync-dune`) to Vercel. `:123` (19/16/3 workflows) contradicts `:765` (20/17/3 — correct). `vercel.json` holds **37** crons; the doc says 36. Also `:§17`'s "the lone exception is `FmvHistoryChart`" is wrong — `components/pinnacle/PinnacleFmvChart.tsx:124` has the identical hardcoded `stroke="#E03A2F"`.

---

## Sweep coverage gaps — not checked, do not assume clean

- **No git-history secret scan** (shell down) — materially affects D2's remedy.
- **`verify_jwt=false` on the 8 edge functions is INFERRED** from in-file comments, not read from deployment config.
- **D1 is confirmed by code + schema reading, not by an actual unauthenticated request.**
- **Rendered-DOM QA ran signed-in as Trevor** (the Chrome profile was already authenticated; signing out would have mutated his session). So `/` (anonymous marketing home) was never assessed and **no gating behaviour was verified**. Not covered: AllDay/Golazos/Pinnacle/UFC `collection`/`sniper`/`analytics`/`market`/`sets` tabs; edition, moment, set, team and pack-dist entity pages; ~30 other `/insights` boards; `/analytics/*`; `/blog`.
- **Top Shot wmc fossil rate is UNKNOWN** — both query shapes hit `57014` on the 1.66M-row table. Golazos/UFC/Candy are 0 and AllDay is 59, so the class looks rare, but that is an inference.
- **Sweep E read the recent ~350 ledger lines + the 1 live inbox file**, not all 81 `docs/handoff-*.md`. "These are the open items in the recent ledger" is supportable; "no other open items" is not.
- **cron-job.org remains un-enumerable.** Its job count is INFERRED from a 142-pipeline residual and is likely ~2× the "~33" CLAUDE.md states.
