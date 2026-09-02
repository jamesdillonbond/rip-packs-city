# Handoff — deep audit run 3 (2026-08-22)

## Context

The monthly deep audit ran 2026-08-22 09:20–11:05 PT from Cowork. **It shipped nothing** — `git push --dry-run origin main` returned `fatal: could not read Username for 'https://github.com'`, and every DB change available was either a documented no-op, security-neutral, or carried an explicit written instruction to wait for the healthy window (detail in [docs/audits/deep-audit-2026-08-22.md](audits/deep-audit-2026-08-22.md) §"Why this pass shipped nothing"). Nothing to revert.

`origin/main` was at `5be01c0e` when the sweeps read it. **Eleven register OPEN items turned out to be already fixed inside the 134 commits the Cowork clone was behind** (R1, R2, R3, R4-render, R5, R7, R10, R12, R13, R15, R16, D31) — the register has been updated to RESOLVED for each with the proof.

Security posture is clean and was re-derived, not inherited: `check_public_security_invariants()` 0 · `check_anon_write_surface()` 0 · `jsonb_array_length(check_secdef_anon_exec_drift())` 0 · RLS 0 uncovered · 0 anon-readable matviews.

> **Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

---

## §1 — P0 · D12 recurred: the public Top Shot analytics tab publishes a 99-day-old single row as market depth

**Files** (all verified present at `origin/main`):
- `app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx` — symbol `OrderBookCard`
- `lib/analytics/methodology.ts` — `listings.paragraphs[1]`
- `app/(analytics)/analytics/listings/page.tsx` — the `metadata.description` string

**Root cause.** `ts_listings` was retired 2026-05-26. Measured 2026-08-22: it holds **exactly 1 row**, `max(ingested_at) = 2026-05-15 14:43Z`, **99.1 days stale**. `analytics_listings_summary` still computes a `topshot_orderbook` block from it, and `OrderBookCard` renders that block for `short === "topshot"`. Anonymous visitors see **"ORDER BOOK DEPTH · 1 listings · MEDIAN ASK $5.0k · P90 ASK $5.0k"** presented as NBA Top Shot market depth.

D12 fixed this on `components/analytics/ListingsDashboard.tsx`, which now says in place that the source "was retired 2026-05-26 and its last row was written on 2026-05-15, so no orderbook depth is shown here." **That fix never reached the per-collection analytics tab.** Register D12 is reopened as **D12b**.

`OrderBookCard` is otherwise well hardened — it has an explicit `failed` branch and a comment naming the honesty class. The gap is a **fourth state nobody modelled**: it handles read-failed, read-ok-empty and read-ok-populated, but has no concept of *read-ok-but-the-source-is-retired*, so `count === 0` is false and the stale row renders.

### ⚠⚠ Do NOT fix this in the RPC — the obvious server-side fix makes it worse

Nulling the `topshot_orderbook` leg of `analytics_listings_summary` looks clean. It is wrong. The card reads `orderbook?.count ?? 0` and branches `count === 0 → "No live listings."` — which would publish **"No live listings"** for a collection carrying **12,259 live `low_ask` rows** in `edition_offers`. Both branches lie. Only the component can tell the truth, which is why this is a code change and not a migration.

### The change

In `OrderBookCard`, add a retired-source branch for Top Shot ahead of the `count === 0` test, mirroring the copy `ListingsDashboard.tsx` already uses. The Top Shot arm should state that the orderbook sampler was retired 2026-05-26 and point the reader at the Sniper deal feed / `edition_offers`-backed surfaces for live ask data; the non-Top-Shot arm (which reads `marketplace_listings`, a live source) is unaffected and must keep working. Prefer a shared constant for the retirement date rather than a fourth copy of the string.

Then correct the two present-tense claims:
- `lib/analytics/methodology.ts` — *"Top Shot orderbook depth is sampled to roughly 100-200 listings on each scan"* is a live public methodology page describing a sampler dead for three months. **A stale disclosure is worse than none** — that is the exact sentence D12 was filed on.
- `app/(analytics)/analytics/listings/page.tsx` — the indexed `metadata.description` says *"a periodically-sampled snapshot of the Top Shot marketplace orderbook"*.

**Guard to add in the same commit.** A test that fails if any rendered surface reads `topshot_orderbook` without a retired-source branch, **derived by walking `app/` + `components/` rather than naming the two known files** — this defect's entire history is a fix that reached one of two copies. Assert the ABSENCE of the false claim, not the presence of an error string, and make it satisfiable at a population of zero.

**Verified how.** `ts_listings` row count / `max(ingested_at)` read directly via Supabase MCP. Rendered output confirmed by screenshot on `https://www.rippackscity.com/nba-top-shot/analytics` as an anonymous visitor. Caller set for `topshot_orderbook` from `git grep origin/main`.

**Revert path.** `git revert <this commit>`. No DB change, so there is no DB half to revert.

**Expected verification.** `npx tsc --noEmit` clean · full `npm test` · Vercel deploy READY **for this commit specifically** (check per-commit — a later push can supersede an ERRORed deploy) · reload `/nba-top-shot/analytics` anonymously and confirm the panel no longer states a listing count, and that `/nfl-all-day/analytics` still renders its `marketplace_listings`-backed numbers.

---

## §2 — P1 · `/insights/candy-mlb` SPREAD panel publishes a failed read as a market fact

**File:** the Candy MLB board's spread panel (the component rendering the `SPREAD` tab under `app/insights/candy-mlb/`).

**Root cause.** The page's own banner already says it: *"PARTIAL DATA: 6 of 10 sections could not be loaded (Pack market, **Offer spread**, Serials, Scarcity, Players, Parallels). This is a temporary database-load failure, not an empty result — treat the affected sections as unknown rather than zero."* Roughly 200 px below, the SPREAD tab carries a badge of **0** and reads **"No offers or asks yet."** The MARKET tab on the same page independently reports **"WITH A BEST OFFER: 26"**.

The page-level banner is the best instance of the honesty canon on the site. The panel is the un-hardened one, and it contradicts the banner on the same screen. **Fix per PANEL** — the banner already knows which sections failed, so the panel should consume that state rather than re-deriving emptiness from a zero-length array.

**Revert path.** `git revert <this commit>`.

**Expected verification.** Load `/insights/candy-mlb` anonymously during a degraded window and confirm the SPREAD tab reads "unknown"/"couldn't load", not "No offers or asks yet." — and that in a healthy window it still renders real spread rows.

---

## §3 — P1 · R6 · `get_collection_stats` fails on 4 of 5 public collection landings, and the KPI band is blank for ~110 s

Confirmed live and anonymous 2026-08-22: `/nba-top-shot/overview`, `/nfl-all-day/overview`, `/laliga-golazos/overview` and `/ufc/overview` all end at *"Couldn't load collection stats right now"*; only `/disney-pinnacle/overview` returns data.

**The copy is honest — this is an availability finding, not an honesty one, and R1's fix is verified working under a real outage.** The renderable defect is the first **~110 s**, during which the three KPI boxes render as empty labelled boxes with no value, no em-dash, no skeleton and no banner. These are the pages the marketing home links to.

Two separable pieces of work:
1. **Cheap and safe now:** give the KPI band a loading state so the first 110 s reads as "loading", not as three blank boxes.
2. **The real fix** remains the filed precomputed latest-FMV-per-edition materialization. ⚠ Its known trap: the naive `DISTINCT ON` over `fmv_snapshots` **timed out at 55 s** when tested, and a concurrent session hit the same wall twice on 08-21. Do not retry that shape.

**Revert path.** `git revert <this commit>` for the loading state. The materialization, when it lands, needs its own inverse migration.

---

## §4 — P1 · Large public entity pages intermittently return an unbranded Next.js 500

`/nba-top-shot/set/base-set` and `/nba-top-shot/team/los-angeles-lakers` both returned the bare *"This page couldn't load — A server error occurred. Reload to try again."* (document title `500: This page couldn't load`), then rendered correctly on retry. **Both are linked directly from the public `/nba-top-shot/overview` catalog** (`href` confirmed in the DOM). Small siblings (`/set/heat-check`, `/team/washington-mystics`) never failed across the same sweep — consistent with a heavy read blowing its budget under the same DB load driving §3.

Every other public surface on the site degrades honestly and in brand. These two bail to Next's default error page, which is both off-brand and uninformative. Wanted: an `error.tsx` boundary for the entity routes that degrades in brand, plus a bounded read so the heavy pages fail as a degraded panel rather than a whole-page throw.

**Revert path.** `git revert <this commit>`.

---

## §5 — P1 · The `*-sales-history-backfill` family is throttled off by its own breaker and is invisible to every failure instrument

**Root cause.** Each of the 9 history backfills opens with a saturation circuit-breaker that returns `{"skipped":"saturation","recent_fails":N}` **and logs `ok: true, rows_written: 0`**. Because `ok` is true, `v_pipeline_failure_rates` reads **0%** and `detect_stalled_pipelines` sees a terminal row arriving on time. **A fully-throttled pipeline is byte-indistinguishable from a caught-up one.**

**Measured**, 48h to 2026-08-22 16:40Z, n=190 runs across 9 pipelines:
- **125 of 190 ticks (65.8%) skipped for saturation**
- total `rows_written` across all nine = **315**, all from `pinnacle-sales-history-backfill`
- **the other eight wrote zero rows in 48 hours**
- `recent_fails` at the newest tick: topshot 154 · pinnacle-studio 163 · golazos-studio 155 · allday-studio 156 · ufc 155 · golazos 152

**The change.** A skip is not a success. Log it under a distinct terminal shape the instruments can see — either `ok: false` with a `skipped` reason, or a separate `<pipeline>-throttled` pipeline name — so that "throttled for two days" and "caught up" stop rendering identically. Then add an arm that fires on sustained throttling.

⚠ **INFERRED sub-claim, worth testing while you are in here:** the breaker may not decay, because a skip logs `ok:true` and so cannot retire the `recent_fails` it is counting. **Refuted if** `recent_fails` on any arm falls materially during a quiet 20:00–00:00Z hour. If it does not decay, the family is latched off permanently and that is the more urgent half.

**This also closes register R17** — but not by the refutation condition R17 named. The two "40,000 blocks, zero decoded" backfills no longer scan at all; every recent tick returns `{"skipped":"saturation"}` in 0.7–29.7 s **before** any block scan. Do not action R17's recommendation.

**Revert path.** `git revert <this commit>`; no DB change.

---

## §6 — P1 · `funnel_events` view volume is ~100% machine traffic and nothing on the table says so

**Measured, 7 days to 2026-08-22 16:30Z — reproduced independently by the audit lead after the sweep reported it:**

| | |
|---|---:|
| events | **15,803** |
| distinct sessions | **15,689** |
| sessions firing >1 event | **53 (0.34%)** |
| null referrer | **99.82%** |
| positive control — `max_events_per_session` | **12** |

`lib/track-funnel.ts::getSessionId()` persists `rpc_sess` in `sessionStorage`, so a real multi-page visit shares one id. 1.007 events per session is a JS-executing crawler with fresh storage per fetch. URL distribution is breadth-first enumeration (6,849 hits across 6,176 distinct edition URLs).

**Why it matters:** `collection_view` rose **82 → 7,738/day** between 08-16 and 08-18 with **zero** change in `wallet_paste`, signups or sign-ins. There is no bot flag on the table. Any future reading of "views" as traction will be wrong by roughly three orders of magnitude.

**The change.** Add a bot/synthetic marker to `funnel_events` — the same role `is_smoke_test` plays on `support_conversations`, where its absence caused a wrong verdict twice. A cheap first cut is a server-side heuristic at write time (UA + single-event-session + null-referrer) recorded as a column rather than filtered away, so the raw record stays intact and every consumer can slice it. **Do not delete or filter the rows** — record the flag.

⚠ Then update whatever reads these counts (the metrics snapshot, any growth artifact) to slice by the flag **before** slicing by time.

**Revert path.** The column addition needs an inverse `ALTER TABLE ... DROP COLUMN`; the write-side change is `git revert <this commit>`.

---

## §7 — P1 · OPERATOR ITEM · Cross-collection mats 132.3 h stale under a "REBUILT DAILY" label (night 4)

**This is the single highest-value action available, and it is blocked only on a time window.**

`cross_collection_cohort_mat` `computed_at` = **2026-08-17 04:10:00Z** (overlap mat 04:25Z) = **132.3 h**, up from 4d19h on 08-21, escalating 1 h/h with no self-heal. pg_cron jobids **60** and **4**: 4 succeeded (latest 08-17), then **6 consecutive daily failures**, both `canceling statement due to statement timeout` inside the `INSERT INTO public.cross_collection_*_mat`. The rendered page states **"COHORT DATA COMPUTED AUG 16, 2026 · REBUILT DAILY"**.

⚠ Split verdict, so nobody over-reads it: the **board tells the truth about its own age** (`FreshnessStamp` reads the mat's own instant, and all three API legs return `boardUnavailable(...)` on error). This is a pipeline failure **plus a stale cadence label**, not a fabricated number.

**The fix is already written and committed — `supabase/migrations/20260822013000_audit_20260821_cross_collection_refresh_lock_window.sql` — and its header specifies the window.** Two steps, in order:

```sql
-- STEP 1 — apply the migration in the HEALTHY window (20:00-00:00Z), NOT the
-- 01:00-19:00Z degraded band. apply_migration costs a ~10-20s burst of
-- user-facing PGRST002 500s from schema-cache re-introspection.
-- (Apply the committed file verbatim; do not retype it.)

-- STEP 2 — only after step 1, move the schedules out of the degraded band:
SELECT cron.alter_job(60, schedule := '10 23 * * *');
SELECT cron.alter_job(4,  schedule := '25 23 * * *');
```

⚠ **Then VERIFY the move took.** `cron.alter_job(schedule := …)` has been recorded silently not taking effect once. Read `cron.job_run_details.start_time` the next day; if either still fires at 04:10/04:25Z, `cron.schedule` a fresh job and `cron.unschedule` the old one.

⚠ **Order is load-bearing.** The migration computes into a temp table and truncates immediately before the tiny insert, dropping the reader-visible `ACCESS EXCLUSIVE` window from 105–350 s to milliseconds. Moving the schedule **without** it trades a permanently-stale board for a daily multi-minute reader stall on a public crawlable page. ⚠ And the migration explicitly **does not make the queries faster** — the 04:10Z runs will keep timing out until they move. Neither step alone is the fix.

**Revert path.** The migration header carries its own guarded inverse. For the schedule: `SELECT cron.alter_job(60, schedule := '10 4 * * *'); SELECT cron.alter_job(4, schedule := '25 4 * * *');`

**Also do NOT apply** `20260820190000_..._snapshot_prune_log_tables` or `20260821021000_..._snapshot_retention_purges` — both are **provenance snapshots**, byte-identical to live, and their own headers say applying them buys nothing and costs the PGRST002 burst.

**Batch R14 into the same window** while the schema cache is reloading anyway — two statements, zero exposure change, closing a standing advisor WARN:

```sql
ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(integer,integer,integer) SET search_path = public;
ALTER PROCEDURE public.rpc_trust_health_precompute_refresh_p() SET search_path = public;
```

⚠ `ALTER`, never `CREATE OR REPLACE` — a `CREATE OR REPLACE` re-declares the body and is exactly how a procedure silently acquires `SECURITY DEFINER` it never had.

---

## §8 — P1 · 29 of 67 deployed edge functions have no committed source

Set diff, not count diff: **67 deployed · 38 committed · 0 committed-but-not-deployed ⇒ 29 with no repo source. 21 of the 29 are `verify_jwt: false`.**

Both credential guards — the hardcoded-credential grep and `__tests__/edge-fn-no-hardcoded-gate-keys.test.ts` — derive their file set from `supabase/functions/**`, so **43% of the fleet is outside them by construction**. This is the documented "a guard's own derivation fixes its blast radius" defect, and it is **proven by example, not theory**: commit `b70d4582` (08-18) found `resolve-allday-rip-dist-api`, a member of that set, deployed with a literal `const GATE` as the sole auth on a service-role writer.

⚠ `compute-achievements` is in the uncommitted set and `verify_jwt:false`. It is the callee of the now-gated R13 POST, so the Next.js side is fixed while the edge function's own auth cannot be audited from the repo.

**Wanted:** pull each of the 29 deployed sources down and commit them (`get_edge_function` per slug), **then** re-derive the guards from the *deployed* list rather than the repo tree so the set can never silently diverge again. ⚠ **Secret safety:** `get_edge_function` returns the FULL deployed `index.ts`; several of these are `?key=`-gated, and echoing one into a transcript has burned a key before. Pull them to disk, do not print them, and scrub before committing.

The 29: admin-badge-backfill-bridge, allday-consumer-gql-smoke, allday-unmapped-bridge, allday-unmapped-resolver, audit-storefront-wallets, backfill-allday-dist-opened, backfill-allday-pack-sales, backfill-golazos-series, backfill-player-names, backfill-topshot-pack-sales, backfill-ufc-thumbs, badge-icon-cache-put, classify-acquisitions, compute-achievements, flowty-loan-indexer, ingest-external-announcements, ipfs-catalog-loader, pinnacle-render-cache-put, pinnacle-render-smoke, pipeline-failure-alerts, resolve-allday-pack-dist, resolve-allday-pull-editions, scan-allday-wallet, scan-golazos-wallet, scan-storefront-events, seed-allday-editions, seed-golazos-editions, shared-deploy-probe, tmp-pack-pool-probe.

---

## §9 — P2 items, ranked, no detail repeated

Each is written up with mechanism, evidence and refutation condition in the register (`docs/audits/deep-audit-register.md`) under the id given.

| id | one line | why it is P2 and not higher |
|---|---|---|
| **R24** | `/api/pack-ev` POST lets an unauthenticated caller set the persisted pack price, the EV denominator and the +EV verdict — **R2's sibling; the R2 fix did not generalise** | Latent: exercised on 25 of 111,736 rows (0.022%) in 30d, all at `pack_price = 10.00`, 0 packs with a conflicting primary/min price. ⚠ `gross_ev`/`pack_ev` are clamped, **`pack_price` is not** |
| **R25** | 8 new `rpc_thp_leg_*` pg_cron jobs have zero `pipeline_runs` observability; one is at 33.3% failure over 7d | The reader-side guard exists — precompute metric ages ≤ 9.8 h and `v_rpc_trust_health_freshness` surfaces them. The gap is that nothing counts how often they miss |
| **R29** | `job startup timeout` is 67–80% of ALL pg_cron failures and writes **nothing** to `pipeline_runs` — pure invisible tick loss (`max_worker_processes = 6` vs `cron.max_running_jobs = 32`) | Cause already filed 2026-08-22T1600Z; this is an independent re-derivation over 11 days. 1.7–8.3% of ~4,000 daily dispatches, spread across 25+ jobs |
| **R30** | `wallet-backfill*` drops ~100k wmc rows/day to upsert-chunk failures | **Not permanent loss** — rows re-walk on the next tick. The cost is redundant IO on an IO-throttled instance |
| **R26** | `scripts/` is outside the `.range()`-requires-`.order()` ban by construction; 10 unordered sites, one of which gates a delete-then-insert on `fmv_snapshots` | The guard is honest about its declared scope (its own detector returns 0 there — that is the positive control). Fix is to add `scripts` to `ROOTS`, then fix the 10 |
| **R27** | `docs/overnight/inbox/` unarchived since 08-13 — **168 live files**, drained and open indistinguishable | ⚠ This audit's brief estimated "~29" — off by 5.8×, which is the evidence the signal degraded silently |
| **R28** | The homepage promises "moment ID" three times; the submit path cannot resolve one and renders "Couldn't find that username", blaming the user | Blast radius is exactly the homepage — every other placement overrides the placeholder correctly |

---

## §10 — P3 items

R31 (~70 titles lost the brand suffix — fix is a `title.template` re-declaration on two intermediate layouts, **not** a re-baked suffix) · R32 (two workflows with the `bash -e` fallible-`jq`-assignment shape; `offer-fill-backfill.yml` is scheduled) · R33 (`/api/top-sales` fabricates `Unknown`/`#0`/`0` and 200s on error for Pinnacle only — **zero callers**) · R34 (Golazos `Circ: 0` tooltip — INFERRED, one DOM read settles it) · R35 (`sitemap.xml` `lastmod` = generation time) · R36 (mobile nav PROFILE → login wall for anon; soft bounce) · R37 (`check-brand-tokens.mjs` LITERAL check uses a curated list while its own second half walks the tree; population outside = 2, both benign) · R38 (`support_conversations.session_id` has no minimum-length `WITH CHECK`) · R39 (two trust-board arms reading the **999 failure sentinel**, i.e. inconclusive not clean) · R40 (two routes log the service-role key's LENGTH; no value) · D30 (3 dead components — ⚠ the register's PROTECTED-entry note was wrong for 2 of 3 and is corrected).

---

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, switch to `main` first.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys — a docs-only tip suppresses the Vercel deploy.
- ⚠ **Re-read `docs/overnight/ledger.md` from disk immediately before writing it**, splice at a **line-start `^### `** (never a substring match), then verify `grep -c '^### '` rose by exactly the entries added, `scripts/find-swallowed-ledger-headings.awk` still prints **3**, and `find-future-dated-ledger-headings.mjs` prints **0**.
- Commit via PowerShell `git` on Windows — Git Bash `git commit` can silently no-op. ⚠ **Backticks in `git commit -m "..."` are command substitution and delete the word silently** — use `git commit -F` with a quoted heredoc. Re-verify with `git rev-list --count origin/main..HEAD` (expect 0).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800 s**; higher sends the deploy to ERROR invisibly. ⚠ `get_deployment.state` LAGS — check deploy state **per commit**, since a later push can supersede an ERRORed one.
- CRLF: don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines. ⚠ Assert the occurrence count before any scripted replace (`n = s.count(old); assert n == 1`).
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.
- **Before gating or short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA, `vercel.json`, pg_cron, in-repo fetches.
- `docs/FREEZE.md` does **not** exist and should not be created — nothing here is a risky refactor.

---

## Paste-ready ledger entry

⚠ The Cowork clone was 134 commits behind and `docs/overnight/ledger.md` moved three times inside those commits, so this entry was **deliberately not spliced** — splicing into a stale copy is how headings get buried. Splice this into the freshly-read file at the first line-start `^### `.

```markdown
### 2026-08-22 · DEEP AUDIT run 3 (Cowork, NO-PUSH) — nothing shipped by design; D12 recurred on a second surface, and the funnel is measuring crawlers

**Read-only.** `git push --dry-run` fatal (no credentials); the clone was 134 commits behind `origin/main`, so every code claim was derived with `git show origin/main:<path>` and cites symbols, not line numbers. Six parallel sweeps + a register re-verification. Security **3/3 clean** (`check_public_security_invariants` 0 · `check_anon_write_surface` 0 · `secdef_anon_exec_drift` 0); RLS 0 uncovered; 0 anon-readable matviews.

⚠ **NOTHING WAS SHIPPED AND THAT IS A DECISION.** Two of the three committed-but-unapplied migrations are **provenance snapshots whose headers say DO NOT APPLY**. The third (`20260822013000_..._cross_collection_refresh_lock_window`) is genuinely ready and fixes a live P1 — **but its own header says apply in the healthy window 20:00–00:00Z**, and this pass ran at 16:20–18:05Z, inside the degraded band. R14's two `ALTER PROCEDURE` statements buy zero exposure reduction and would pay the same schema-reload burst. Overriding a written window instruction to save three hours, on an instance whose recorded repeated mistake is adding load during saturation, is not a trade worth making.

**🚨 P0 — D12 RECURRED, and the register had it RESOLVED.** `/nba-top-shot/analytics` publishes **"ORDER BOOK DEPTH · 1 listings · MEDIAN ASK $5.0k"** to anonymous visitors. `ts_listings` holds **exactly 1 row, `max(ingested_at) = 2026-05-15`, 99.1 days stale**; the sampler was retired 2026-05-26. D12 was fixed on `ListingsDashboard.tsx` **only** — the identical panel in `CollectionAnalyticsClient.tsx::OrderBookCard` was never touched. ⚠⚠ **The obvious DB-side fix makes it WORSE:** the card reads `orderbook?.count ?? 0` and branches `count === 0 → "No live listings."`, which is FALSE for a collection with 12,259 live `low_ask` rows. ⚠ A **fourth state** nobody modelled — the card handles read-failed / read-ok-empty / read-ok-populated but has no concept of *read-ok-source-retired*. Two more surfaces carry the claim in the present tense (`lib/analytics/methodology.ts`, the listings page `metadata.description`).

**⚠ THE FUNNEL IS MEASURING CRAWLERS.** 7d: **15,803 events / 15,689 distinct sessions**; only **53 sessions (0.34%)** fired >1 event; **99.82%** null referrer; positive control `max_events_per_session = 12`. `collection_view` rose **82 → 7,738/day** (08-16→08-18) with **zero** change in `wallet_paste`, signups or sign-ins. There is no bot flag on the table. The `is_smoke_test` lesson in a new table — except the flag does not exist yet.

**Demand gate unmoved:** 21 users · **0 WAU** · 0 new in 7d · 5 `wallet_paste` in 7d. Newest signup 08-08, newest sign-in 08-14.

**✅ ELEVEN register OPEN items were already fixed in the 134 commits** — R1 (verified under a REAL outage, the strong form), R2, R3, R4-render, R5 (confirmed with R5's own prescribed positive control), R7, R10, R12, R13, R15, R16, D31. **⚠ R4's PIPELINE half was a MEASUREMENT ARTIFACT**: the "escalating to 86.4% NULL" was the trailing edge of a **daily** bridge (jobid 184, `41 5 * * *`) read at one instant — settle curve 0–6h 87.31% → 24–48h 3.61% → **>7d 0.98%**. Refutation condition for the overturn: >7d above ~2% IS a break. **⚠ R7's "chronic 120 s rollback" is refuted for the current window** — `split` ran 17,725 ms, not 125,250.

**Other corrections:** R17 closed but NOT by its own refutation condition (it is a member of the new R20 saturation-breaker family) · D18 closed as **UNVERIFIABLE** (the list was never enumerated) · D37 **shrank and its growth stopped** (9 rows/24h vs a filed +1,376/day, with an ingest control run) · D21 improved 11.5d → 5.11d · Vercel crons are **36, not 38** · pg_cron 85→93 is **+10 added, −2 removed** (diff the SET) · CI drifted **upward** on every axis (8→10 jobs, all three gates raised) · UFC FMV coverage **89.77% → 100%** · `fmv-recalc`'s 72.7% wall-kill figure is stale in **both** directions.

**⚠ The accuracy gate's "two figures" are not a disagreement.** The instruments agree on 4 of 5 collections; **100% of the gap is one deliberate Top Shot canonical-only filter dated 2026-08-04**, and the arithmetic closes to 34.3% vs the filing's 34.2%. **Publish it as `49.7% (canonical Top Shot) / 34.3% (all rows)` or fix the producer.**

**New P1s:** the 9-pipeline `*-sales-history-backfill` family is throttled off by its own breaker and logs `ok:true` (125/190 ticks skipped in 48h; 8 of 9 wrote zero rows) so it is invisible to every failure instrument · **29 of 67 deployed edge functions have no committed source, 21 of them `verify_jwt:false`**, and both credential guards derive their file set from `supabase/functions/**` · `/insights/candy-mlb` SPREAD publishes a failed read as "No offers or asks yet" under its own PARTIAL-DATA banner · cross-collection mats **132.3 h** stale under a "REBUILT DAILY" label (night 4) · large entity pages intermittently return an unbranded Next.js 500.

**Revert:** nothing to revert — read-only pass, docs only. Register rewritten: [docs/audits/deep-audit-register.md](audits/deep-audit-register.md). Full report: [docs/audits/deep-audit-2026-08-22.md](audits/deep-audit-2026-08-22.md). Handoff: [docs/handoff-2026-08-22-deep-audit-run3.md](handoff-2026-08-22-deep-audit-run3.md).
```

---

## Expected end state

D12b closed on all three surfaces with a tree-walking guard; the candy-mlb SPREAD panel consuming the banner's own failure state; the cross-collection migration applied in a 20:00–00:00Z window followed by the verified schedule move, taking the mats from 132 h stale back to daily; a bot flag on `funnel_events` so the demand gate stops competing with crawler volume; and the 29 uncommitted edge functions pulled into the repo with the guards re-derived from the deployed list. Commits on `main`, deploys READY per commit, nothing on a branch.
