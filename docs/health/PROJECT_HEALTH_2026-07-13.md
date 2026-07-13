# Rip Packs City — Project Health Report

**Date:** 2026-07-13
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Cross-session Safety §, Recent Sessions § — current through the 2026-07-13 overnight entry), `docs/overnight/ledger.md` (large, spot-queried) + `docs/overnight/metrics-latest.json` (fresh, captured **2026-07-13T08:11Z**) + `docs/overnight/focus.md` (stale, dated 2026-06-24), and a first-hand `TODO/FIXME/HACK/XXX` scan of the source tree plus line-count / file-existence verification via the Read/Grep file tools.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-07-06.md` (7 days ago). This regeneration mirrors its structure. `_2026-06-29.md`, `_2026-06-22.md`, `_2026-06-15.md`, `_2026-06-08.md`, `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Tooling caveat for this run (READ FIRST).** The Cowork **bash/git sandbox failed to provision** this session (`useradd: exit status 12` — the same infra failure the 07-12 and 07-13 overnight passes hit two nights running), so this report was produced **without `git`** (no commit count / `git log` this week) and **without `wc -l`** (line counts were taken with a ripgrep line-count, cross-validated against last week's verified figures). The **Glob tool was also unreliable** this run (false "No files found" on paths that provably exist), so every file-existence and path check below was done with **Grep** (reliable all session) or **Read** (definitive). What the "shipped this week" narrative rests on is therefore `CLAUDE.md`'s Recent-Sessions entries + `metrics-latest.json` + first-hand file reads — **not** a git diff. Where a figure could not be independently verified, it is flagged.

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all eleven reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-07-06 — a heavy interactive Claude-Code day (07-12), a real monolith refactor, and two nights of tooling-constrained-but-GREEN overnight passes.** No commit count is available this week (git down), but the substance is clear from `CLAUDE.md` and first-hand verification. Five stories: **(1) Test-coverage infrastructure landed as a new durable convention (07-12).** A broad vitest sweep now covers `app/api/**/route.ts` handlers (auth/param guards + a large subset of 2xx paths) and pure `lib/**` logic, with a separate jsdom component/hook harness (`__tests__/*.test.tsx`) and Deno edge-fn logic extracted to vitest-importable `supabase/functions/_shared` modules. CI runs `npm run test:coverage` against a **ratchet threshold** in `vitest.config.ts` (baseline stmts 34.3 / branch 26.5 / funcs 39.4 / lines 36.5) so a coverage drop fails CI. This is why the TODO scan now surfaces test-file references to the gated Candy/Panini placeholders (see §5, treated as descriptive, not actionable). **(2) A genuine monolith refactor — the two real monoliths shrank hard.** `collection/page.tsx` **2,870 → 1,529** (−1,341) and `sniper/page.tsx` **2,191 → 1,712** (−479); the collection page's moment table was extracted into `components/collection/CollectionMomentTable.tsx` (the `team_name` TODO relocated there). This is the biggest movement on the #14 monolith item in the report's history. **(3) Top Shot "bulk-buy" reverse-engineering → read-side intelligence.** Dapper "Quick Buy" was found to be N independent single-moment txs (not atomic multi-buy); in-app execution stays blocked by the Dapper co-signer wall, so the shipped output is intelligence: a floor-sweep (bulk-buy) detector, a set-completion bulk-buy planner, "Hot Floors," and concierge tools surfacing them. **(4) Alert-funnel consolidation + a real pg_cron heavy-job timeout fix.** The legacy `fmv_alerts` mis-route was retired in favor of the canonical `alerts-dispatch → alert_deliveries → alerts-send` outbox; admin-token storage was unified; and a dedicated `cron_heavy` role (600s per-role default) fixed the heavy pg_cron jobs whose earlier inline-`statement_timeout` migration was inert. **(5) A challenges feature + concierge gap-closure.** A `searchChallenges` ingest scheduler + `get_active_challenges` (31 items live) + a `rpc-set-challenge-roi` artifact shipped (prod HEAD `2d57889f`); and the 07-11 concierge session closed 4 Telegram-bot capability gaps (combo deal-alert subscriptions, team/badge serial filters, squeeze FMV totals, cheap-pack EV fix).

> **In-code debt fell: 65 → 59 real markers (−6).** The single biggest cleanup: the `special-serial-sweep` edge function's AllDay / Golazos / UFC ownership legs were **fully implemented** on 07-12 (via `lookupOwnerFromWmc`, "Verified data path 2026-07-12"), zeroing out the §5c cluster (3 → 0). TopShot was already unblocked last week, so **A1 special-serial owner display is now resolved for all four collection legs.** Also removed: the `topshot-moments-hydrator` batch-RPC TODO (the `replace_topshot_moments_batch` migration landed), the `fast-break-optimizer` captain-bonus TODO, and the pack-lifecycle OG-image TODO (that share card was built). See §5 / §8.

> **Overnight reality — GREEN, but the passes are tooling-blocked.** The 07-11/07-12/07-13 overnight passes ran, but 07-12 and 07-13 hit the **bash/git sandbox provisioning failure**, forcing **NO-PUSH for code** (commits/deploys impossible) — each correctly shipped **0**. Post-ship watches of the heavy 07-12/07-13 daytime waves were **ALL PASS, 0 reverts**. Health read GREEN throughout: security **0/0/0/0**, trust breaches **[]**, sentinel TS-UUID 48h **0**, Sentry **0 new**. The standout operational finding is now the infra one: **BASH/GIT-SANDBOX-PROVISION-FAILURE** (2nd consecutive night, escalating — it removes the night pass's ship capability and likely blocks the monitor's inbox push).

> **Traction reality (carried — no fresh snapshot this run; git/bash down).** The last logged traction read remains **2026-05-31: ~13 total users, 0 signups in 7 days, 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** Monetization stays tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation* and *measurement*. **Cost/storage is the one concrete financial pressure and it grew again:** `metrics-latest.json` puts the **DB at 11,044 MB** — up **~2.9 GB** from last week's ~8,159 MB (the deep-history + subedition-cataloging waves). Day-over-day it actually plateaued (−117 MB vs 07-12's 11,161; wmc autovacuum reclaimed, and the 07-12 "+2 GB/day" creep did **not** continue), but the week-over-week trend is now the clearest cost line to watch. A secondary index-bloat item (`idx_wmc_lower_wallet_coll_edkey`, ~339 MB / 29 scans) is queued for REINDEX-or-DROP.

> **Platform context (unchanged, still material).** **(1) Flowty shut its marketplace FRONTEND (~2026-05-13) but its API is ALIVE** — the listing-cache pipelines + `flowty-proxy` edge fn are LIVE ingest feeding cached_listings + ASK FMV today; teardown premise is OBSOLETE (do not delete the caches). **(2) NFL All Day ended primary pack sales** — AllDay pack-EV is historical/secondary-market only. **(3) UFC Strike is migrating to Aptos** — the Flow UFC market is frozen (permanent); the UFC-sales-indexer watchlist was relaxed 90→240m on 07-11 to stop false stall-trips. **(4) Chain-two (Candy / Solana) prebuild is inert** — the July-8 Candy data tripwire has now passed; the 17-line discovery-placeholder block (§5g) is unchanged and still unfilled (confirm whether ≥30 days of Candy sales history materialized before touching it). **(5) The Panini WC2026 Prizm "Plane-A" ingest scaffold remains inert** — repo-only, writes nothing (§5h).

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **verified absent this run = no freeze active.** **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md` since last week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Net-new shipped features (not numbered) | **8+** | Test-coverage infrastructure + CI ratchet (NEW); Top Shot bulk-buy intelligence + Hot Floors (NEW); challenges feature + `rpc-set-challenge-roi` (NEW); alert-funnel consolidation (NEW); concierge combo-subscriptions + filters (07-11); **+3 new `/insights` surfaces** (28 total); monolith component-extraction refactor; A1 special-serial owner display now complete across all 4 collections — §2.1 / §2.2 / §2.3 |
| Open overnight operational items | **~8 active + ~5 deferred** | New this week: **BASH/GIT-SANDBOX-PROVISION-FAILURE** (operator/infra, escalating); **WMC-INDEX-BLOAT-SECONDARY** (REINDEX-or-DROP). Carried: VERCEL cost family; ALLDAY-V1-UNMAPPED-DRIFT; CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT; THIN-FMV-GUARD-CONTENTION; `refresh-conflated-editions` cron (operator); PIN-FMV-REKEY waves 2/3; cron-job.org trigger-dropout family. **Operator (from 07-12):** remove the cron-job.org entry hitting the retired `/api/cron/check-alerts`. Deferred: ALLDAY-PACK-OPENS-BACKFILL-404, WEEKLY-SURFACE-QA-PROSE, IPFS ×2 — see §2.6 |
| Net-new structural workstream | 3 | Multi-chain chain-abstraction (Phases A–F complete; 18 shim TODOs) + the inert Candy/Solana chain-two prebuild (17 TODOs, July-8 gate now passed) + the inert Panini WC2026 Plane-A scaffold (10 TODOs) (§2.8) |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; Priority #1 (Flowty) OBSOLETE-recommended-closed (keep the LIVE caches, close the teardown). Activation-measurement + cost-right-sizing still arguably belong here. |
| In-code TODO markers | **59 real lines / 34 files** (+3 false positives, +9 descriptive test refs) | **−6 vs last week's 65.** Drops: §5c special-serial-sweep 3→0 (AllDay/Golazos/UFC implemented), §5d 3→1 (hydrator RPC + fast-break), §5e 4→3 (pack OG built) — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A *test-and-refactor-led* week layered on continued intelligence build. The 07-12 Claude-Code day is the substance: durable test-coverage infrastructure (a new convention worth respecting), a real monolith refactor that finally moved the #14 needle (collection −1,341 / sniper −479 lines via component extraction), Top Shot bulk-buy intelligence + Hot Floors, alert-funnel consolidation, a real pg_cron heavy-job fix, and a challenges feature. In-code debt fell 65 → 59 markers, headlined by the `special-serial-sweep` AllDay/Golazos/UFC legs being implemented (A1 now complete across all four collections). Operationally the platform reads GREEN (security **0/0/0/0**, trust breaches **[]**, sentinel **0**, Sentry **0 new**, editions growth explained as `::` subedition cataloging), and the overnight post-ship watches passed with 0 reverts — but the passes themselves are **tooling-blocked** two nights running by the bash/git sandbox failure, which is now the single most actionable operational item because it removes the night pass's ability to ship. The dominant *product* concern is unchanged: **activation/traction** (≈13 users at last read). Descending, concentrated risk: **(1)** the bash/git-sandbox infra failure (blocks autonomous shipping + likely the monitor inbox); **(2)** cost/storage — DB now **~11 GB**, +~2.9 GB in a week (day-over-day plateaued); **(3)** FMV-correctness tails (Pinnacle per-render waves 2/3; subedition convergence). Chain-foundation cleanup tails (18 shims + 17 Candy + 10 Panini intentional TODOs) and the remaining page-polish items are secondary.

### Themes

| Theme | Items |
|---|---|
| Test / quality infrastructure (NEW headline) | Vitest route+lib coverage sweep, jsdom component harness, `supabase/functions/_shared` edge-fn extraction, CI coverage ratchet in `vitest.config.ts` (§2.4). Do NOT lower the thresholds to green a build. |
| Data-intelligence correctness + surface build | Top Shot bulk-buy intelligence (floor-sweep detector, set-completion planner) + Hot Floors + honest floor pricing; challenges feature; concierge gap-closure; +3 `/insights` surfaces; subedition/parallel-conflation program continuing (TopShot editions 19,241) (§2.2 / §2.3) |
| Conversion / activation (the real critical path) | **Still built-but-unmeasured** — omni-channel alerts (LIVE, combo team/badge/serial/discount subscriptions now reachable via concierge); SEO surfaces; Rewards economy (DIAL-IN). **Verify `funnel_events` accumulates; measure whether signups / alert sign-ups move off zero.** (§2.1) |
| Tech debt / refactor (moved this week) | Monolith refactor advanced hard — collection **1,529** (−1,341) / sniper **1,712** (−479) via component extraction; `/dashboard` **2,360** (+347, grew with bulk-buy/Hot-Floors features); analytics **495** (already split; CLAUDE.md #14 figure still stale) (§3 / §8) |
| Safety / reliability hardening (held) | Destructive-op circuit-breaker + per-collection FMV freshness stayed live; alert-funnel consolidation retired a mis-route; the real pg_cron `cron_heavy` 600s fix; security **0/0/0/0** through every migration (§2.4) |
| Security / dependency hygiene | `check_public_security_invariants()` **0** all week; `next`/`eslint-config-next` hold at 16.2.9; residual transitive HIGHs are the onflow→viem→ws chain (monitor-only). (§2.4) |
| Cost / operational right-sizing (carried + grown) | Vercel cost family carried; **DB now ~11,044 MB** (+~2.9 GB this week; day-over-day plateaued −117 MB) + **WMC-INDEX-BLOAT-SECONDARY** (~339 MB, REINDEX-or-DROP). Clearest financial line. (§2.6) |
| Operational / overnight queue | **BASH/GIT-SANDBOX-PROVISION-FAILURE** (new, escalating); WMC-INDEX-BLOAT-SECONDARY (new); Vercel cost cluster; cron-job.org trigger-dropout family; ALLDAY-V1-UNMAPPED-DRIFT; CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT; THIN-FMV-GUARD-CONTENTION; `refresh-conflated-editions` cron; PIN-FMV-REKEY waves 2/3; **operator: remove the `/api/cron/check-alerts` cron-job.org entry** (§2.6) |
| Multi-chain foundation | Chain-abstraction Phases A–F complete (18 shim TODOs); Candy/Solana chain-two prebuild inert (17 TODOs, **July-8 gate now passed**); Panini WC2026 Plane-A scaffold inert (10 TODOs) (§2.8 / §5a / §5g / §5h) |
| Page polish | Pack/Moment/Set tune-up (#17 — Hot Floors + honest floor pricing + Trophy Case polish landed); brand punch list (#11 — token sweep complete); Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded, 8 stub TODOs); Cart (#1, shelved by decision); Top Shot in-app bulk-buy execution (blocked by the Dapper co-signer wall — intelligence shipped instead) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id` migration; `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

Intelligence-first with revenue shelved by decision. This week the test-infrastructure + monolith refactor + bulk-buy intelligence led; activation and measurement still lead what's *next*, and this week adds the **infra reliability** of the autonomous tooling itself.

### 2.1 Conversion / activation — machinery built, still unmeasured — `Severity: High · Effort: Medium (shipped, unmeasured)`

The funnel machinery keeps growing; measurement hasn't caught up (and this run couldn't add a fresh traction snapshot — git/bash down):

- **Omni-channel alerts — combo subscriptions now reachable end-to-end.** The 07-11 concierge session exposed `manage_deal_subscriptions` (subscription CRUD on web + bot DMs) and added team/badge serial filters, so a subscriber can now build combo alerts (e.g. Blazers + rookie badges + serial-only + 25% discount → Telegram) that the concierge previously couldn't reach. 1 active subscription (Trevor's live test). **Next step still: open to the allow-list and watch sign-ups.**
- **Challenges feature (NEW).** A `searchChallenges` ingest scheduler + `get_active_challenges` (31 items live) + a `rpc-set-challenge-roi` artifact — a new engagement surface. Worth instrumenting alongside the funnel.
- **SEO / `/insights` surfaces** — +3 this week (§2.2). Organic discovery is the cheapest acquisition channel for a ≈13-user product; still unmeasured for impression lift.
- **Rewards points economy** (live, carried, status **DIAL-IN**) — store stocking awaits Trevor's Moment picks; raffle held pending legal review. No code blocker.

Suggested next step (unchanged, still highest-leverage): confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop, the alerts loop, and the new challenges surface (sign-ups, channel links, deliveries, participation); open alerts to the allow-list; then watch whether signups move off zero. Worth promoting to an explicit `CLAUDE.md` prioritized action.

### 2.2 Public intelligence surfaces — expanded to 28 — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2.

- **`/insights` hub — now 28 surfaces** (verified: `INSIGHT_ROUTES` in `lib/sitemap-data.ts` = 28 entries, and the `app/insights/` dir has 28 surface `page.tsx` files + the hub index — they agree). **+3 this week:** `parallel-premiums`, `market-pulse`, `set-completers`. (Note: the sitemap source moved from `app/sitemap.ts` to `lib/sitemap-data.ts` since last week.)
- **Hot Floors + honest floor pricing** — a new sets tab showing editions being actively swept; "cost to complete" now reflects real floor not FMV; edition ask-floor coverage widened via `edition_offers` (33% → 53%).
- **Top Shot bulk-buy intelligence** — a floor-sweep (bulk-buy) detector and a set-completion bulk-buy planner, surfaced through concierge tools. In-app *execution* stays blocked by the Dapper co-signer wall (same class as Cart / Trade Hub), so this is read-side intelligence.

No open defects tracked here; listed because it is a large body of *shipped* product work.

### 2.3 FMV / data-intelligence correctness — continued — `Severity: was High (correctness) · Effort: large, mostly landed`

- **Subedition / parallel-conflation program continues.** TopShot editions rose to **19,241** (+1,097 vs last week's 18,144) — 100% `::subID` parallel catalog rows, explicitly *not* a writer leak (sentinel TS-UUID-leak 48h = **0**, verified in `metrics-latest.json`).
- **A1 special-serial owner display — now COMPLETE across all four collections.** Last week TopShot resolved via Path B (`getMintedMoment.owner`); this week (07-12) the AllDay / Golazos / UFC legs were implemented via `lookupOwnerFromWmc` (wallet_moments_cache denorm, "Verified data path 2026-07-12": edition_key matches external_id on 99.98% AllDay / 100% Golazos+UFC). Coverage of the un-walked / never-traded remainder is bounded by backfill breadth (resolves to null, re-attempted as backfill widens) — a live per-collection Cadence/GQL owner lookup (Path A) is the future extension, logged via the sweep's `unresolved` tally.
- **FMV coverage (from `metrics-latest.json`, 2026-07-13T08:11Z):** TopShot HIGH 1,438 / MEDIUM 3,756 / HIGH+MED **5,194**; AllDay HIGH+MED 806; UFC 15; Golazos 4. `edition_integrity_flags` 4; `impossible_parallel` 1; Pinnacle `fmv_stale` 22h / `ask_stale` 0.2h.
- **Pinnacle per-render FMV (PIN-FMV-REKEY).** Carried — engine `pinnacle-2.0.0-render` (table `pinnacle_fmv_history`) primary. **Remaining (Trevor-sequenced): waves 2/3** then retire any legacy readers.

Suggested next step: watch the subedition + deep-history backfill converge; keep `v_fmv_sanity_flags` + the per-collection `*_fmv_stale_hours` tripwires in the weekly health check; finish PIN-FMV-REKEY waves 2/3.

### 2.4 Safety / reliability + test infrastructure + dependency hygiene — `Severity: Medium (held) · Effort: mostly done`

- **Test-coverage infrastructure (NEW, durable).** Vitest now covers `app/api/**/route.ts` + pure `lib/**`; a jsdom harness covers components/hooks; Deno edge-fn logic is extracted to `supabase/functions/_shared` (`cdc.ts`, `hybrid-custody-parse.ts`, `pack-ev-edition.ts`, `spork-cursor.ts`). CI (`unit-tests` in `.github/workflows/ci.yml`) runs `npm run test:coverage` against a **ratchet** (baseline stmts 34.3 / branch 26.5 / funcs 39.4 / lines 36.5). **Convention: raise the thresholds as coverage climbs; NEVER lower them to green a red build.** A route line-% in the 30s is expected (deep inline GraphQL/Cadence bodies can't be cleanly driven).
- **Alert-funnel consolidation.** The legacy `fmv_alerts` mis-route (`/api/cron/check-alerts`) was retired in favor of the canonical `alerts-dispatch → alert_deliveries → alerts-send` outbox; admin-token storage unified (`localStorage`, shared `rpc_admin_token`). **OPERATOR:** remove the cron-job.org entry still pointing at `/api/cron/check-alerts`.
- **pg_cron heavy-job timeout fix (the real one).** The 07-11/07-12 inline-`statement_timeout` migration was **inert** (pg_cron arms the timeout once at batch start from the session default). Fixed with a dedicated `cron_heavy` role carrying a 600s per-role default, so heavy jobs (`cross-source-dedup`, `fmv-clamp`, `ccm-step1`, `backfill-historical-pack-ev`, etc.) no longer die at 120s.
- **Destructive-op circuit-breaker + per-collection FMV freshness — still LIVE**, no new incident.
- **Security invariants held 0.** `check_public_security_invariants()` stayed **0** through every migration; a security revoke of anon/authenticated EXECUTE on the new SECDEF fns shipped (07-12).
- **Dependencies hold at `next`/`eslint-config-next` 16.2.9.** Residual transitive HIGHs (the onflow→viem→ws chain) stay **monitor-only**; `stripe@^22` present but dormant (monetization tabled).

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The overnight/monitor passes continued routine hygiene, but **two nights (07-12, 07-13) were tooling-constrained** by the bash/git sandbox failure — each correctly shipped 0 and confirmed the daytime waves DB-clean via post-ship watch. `metrics-latest.json` is fresh (2026-07-13T08:11Z). **Two hygiene flags:** (a) `docs/overnight/focus.md` is still dated **2026-06-24** — now **19 days stale** (was 12 at the last report) — worth a refresh so the passes steer on current priorities; (b) the autonomous night pass has now been unable to push code for two consecutive nights (see §2.6, the sandbox item).

### 2.6 Overnight operational queue — infra-led this week — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue gained two notable items; the dominant one is now infrastructure. **Closed/reconciled recently:** the cron-job.org trigger-dropout instances self-healed (cursor-based, no data loss); the UFC-sales watchlist was relaxed (07-11); DB-SIZE-CREEP was downgraded from watch to noted-stable (day-over-day reclaim). Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **BASH/GIT-SANDBOX-PROVISION-FAILURE** (new) | The Cowork sandbox VM failed to provision two nights running (`useradd` exit 12) → no git clone, no mount-git fallback → the night pass **cannot push code**, and it likely blocks the daytime monitor's inbox push (same dependency). DB + Supabase/Vercel/Sentry MCP + Read/Write/Edit/Grep unaffected. | **Med (escalating)** | Operator/infra. This is the highest-leverage operational fix — it restores the autonomous pass's ability to ship. |
| **WMC-INDEX-BLOAT-SECONDARY** (new) | `idx_wmc_lower_wallet_coll_edkey` ~339 MB against only ~29 scans — a REINDEX-or-DROP candidate as part of the DB right-sizing. | Low–Med | CC/operator. Folds into the cost/storage line. |
| **VERCEL cost family** | Carried (FLUID-RIGHTSIZE, CRON-CADENCE, SPEND-PAUSE backstop, OBSERVABILITY-SAMPLING). **Compounded by DB now ~11,044 MB** (+~2.9 GB this week). | Med | Mostly Trevor (dashboard) + operator. The SPEND-PAUSE monthly-cap backstop is the do-regardless one. |
| **cron-job.org trigger-dropout family** | Recurring: batches of cron-job.org-triggered pipelines briefly freeze (external trigger, not our stack); cursor-based ⇒ no data loss, self-heals. | Low | Operator: inspect cron-job.org execution history when it recurs. |
| **`/api/cron/check-alerts` orphan cron** (new, operator) | The 07-12 alert-funnel consolidation retired this route to an auth-gated no-op; the cron-job.org entry still pointing at it should be removed. | Low | Operator. |
| **CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT** | The `nfl_all_day` classify leg flaps at its statement_timeout as `allday_studio_history_v1` fills (batch-cap fix bought headroom). | Low–Med | CC/operator: re-measure after the studio backfill finishes. |
| **PIN-FMV-REKEY waves 2/3** | Last Pinnacle per-render reader cutover + legacy retirement. | Med | Trevor-sequenced (price-display change). |
| **ALLDAY-V1-UNMAPPED-DRIFT** | Open AllDay `unmapped_sales` are `source=onchain_dapper_v1` (budget-exhausted); correctly held out of `sales`. Hard tail. | Low | Operator: classify as permanent or wire the recover cron. |
| **`refresh-conflated-editions` cron** | Daily honesty-guard refresh still pending operator wiring. | Low | Operator. |
| THIN-FMV-GUARD-CONTENTION | `rpc-refresh-thin-fmv-guard` occasionally times out under a micro-contention window. | Low | CC: planner/timeout fix if it recurs. |
| ALLDAY-PACK-OPENS-BACKFILL-404 / WEEKLY-SURFACE-QA-PROSE / IPFS ×2 | Historical-enrichment stall (forward path healthy) + cosmetic prose + deferred IPFS items. | Low (deferred) | Explicit triggers in the ledger; do not build now. |

### 2.7 Pack EV / pack-viz — improved this week — `Severity: Low · Effort: shipped`

Pack-EV stayed a live surface: Hot Floors surfaces actively-swept sets, "cost to complete" now uses real floor not FMV, and hot-floors "Avg paid" (sale-based) is shown as the primary price. The one carried queue item is the LOW ALLDAY-PACK-OPENS-BACKFILL-404 historical-enrichment stall (§2.6).

### 2.8 Chain foundation — abstraction complete; two inert chain scaffolds; July-8 gate now passed — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F are complete** (Phase F shipped 2026-06-01). **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged, bulletproof by design. **Trap:** `lib/flow.ts` is the only shim with `export default` — keep `export { default }` alongside `export *`.
- **Candy / Solana chain-two prebuild is inert — and its gate date has now passed.** `collections` seeded (`candy_mlb`/`panini_blockchain`, `is_active=false`), `helius-proxy` scaffolded; it writes nothing until the five discovery placeholders are filled (§5g). **The July-8 Candy data tripwire is now in the past — the open question is whether ≥30 days of Candy Solana sales history actually materialized.** Confirm that (a `CLAUDE.md`/ledger decision) before filling the placeholders; until then, leave inert.
- **Panini WC2026 Prizm "Plane-A" ingest scaffold is inert** — repo-only, writes nothing until a per-mode discovery capture is filled (§5h). Also inert: a Dune-backed TopShot ownership index.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 0 | **Wallet verification.** "Sign in with Dapper" gated on Dapper developer access (request pending). The working path is the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim owner-attested fallback. The old `cached_listings` cron matcher is dead (frozen data) but left harmless. | Medium | Medium (core shipped; Dapper path blocked externally) |
| — | Activation machinery (omni-channel alerts w/ combo subscriptions LIVE; challenges NEW; SEO surfaces; Rewards economy) shipped; **verify `funnel_events` is recording and measure whether signups / alert sign-ups / SEO impressions move off zero.** | High | Medium (shipped, unmeasured) |

### Test / quality infrastructure (the headline this week)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Test-coverage infra | Repo had thin automated testing. **Shipped** — vitest route+lib coverage, jsdom component harness, `_shared` edge-fn extraction, CI coverage ratchet. | was Medium | (landed; raise thresholds over time) |

### Data-intelligence correctness

| Item | Issue | Severity | Effort |
|---|---|---|---|
| A1 special-serial owner display | AllDay/Golazos/UFC owner legs were stubs. **Shipped 07-12** via `lookupOwnerFromWmc` — all four collections now resolve owners (TopShot via `getMintedMoment`, the other three via wmc denorm). Un-walked remainder bounded by backfill breadth. | was Medium | (landed) |
| Subedition / parallel-conflation | Parallel `::` moments cataloged into own editions. **Ongoing** — TopShot editions 19,241 (cataloged parallels, not a leak). | Medium | Medium (in progress) |
| Top Shot bulk-buy intelligence | Quick-Buy reverse-engineered; execution blocked by co-signer wall. **Shipped read-side** — floor-sweep detector + set-completion planner + Hot Floors. | was Medium | (landed) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary; waves 2/3 + legacy retirement queued (Trevor-sequenced). | Medium | Medium |

### Safety / reliability hardening

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Alert-funnel consolidation | Legacy `fmv_alerts` mis-route + split admin-token storage. **Shipped** — retired to canonical outbox; unified token; ops alerts push on red health. Operator: remove the orphan cron entry. | was Medium | (landed) |
| pg_cron heavy-job timeout | Heavy jobs died at 120s; the inline-timeout migration was inert. **Fixed** — dedicated `cron_heavy` role, 600s. | was Medium | (landed) |
| Destructive-op guard | Bulk deletes on irreplaceable tables could corrupt silently. **LIVE**, no new incident. | was High | (landed) |

### Cost / operational right-sizing (carried + grown)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage growth | DB **~11,044 MB** — +~2.9 GB this week (deep-history + subedition waves). Day-over-day plateaued (−117 MB). **Watch the week-over-week rate; decide a retention posture.** | Medium | Small (monitor + decide retention) |
| WMC index bloat (secondary) | `idx_wmc_lower_wallet_coll_edkey` ~339 MB / ~29 scans — REINDEX-or-DROP candidate. | Low–Med | Small |
| Vercel cost family | Carried (uncapped Spend-Management + Fluid/cron/observability levers). | Medium | Small–Medium (dashboard + cron config) |

### Infra reliability (new)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Bash/git sandbox failure | The Cowork sandbox failed to provision two consecutive nights (`useradd` exit 12), blocking the night pass's code-push capability + likely the monitor's inbox push. | Medium (escalating) | Operator/infra |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports, then delete). Intentional, low-risk. | Low | Medium |
| Candy chain-two | 17-line discovery-placeholder block in the inert Candy/Solana path — **July-8 gate now passed; confirm whether ≥30d of sales history materialized before filling.** Intentional. | Low | Medium |
| Panini WC2026 | 10-marker block in the inert Panini "Plane-A" scaffold — unfillable until a per-mode discovery capture lands. Repo-only. Intentional. | Low | Medium (gated) |

### Tech debt / refactor (moved this week)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — **advanced hard this week.** `collection/page.tsx` **1,529** (DOWN 1,341 — moment table extracted to `components/collection/CollectionMomentTable.tsx`) / `sniper/page.tsx` **1,712** (DOWN 479). **The analytics figure in `CLAUDE.md` #14 (~2,128/2,208) remains STALE** — the actual `/analytics` page is **495 lines**, already split. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (much progressed) |
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,360 lines** (UP 347 — grew with the bulk-buy / Hot-Floors features). Big lift, deferred until stable. | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set page tune-up. This week: Hot Floors, honest floor pricing, Trophy Case frontend polish landed. Remaining lower-value tier: modal accessibility (Moment V3 / Set V5), Set B5 (series rollups from first 100 editions — needs aggregate RPC), Set B7 (client-sort partial-page). Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, all present) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — theme tokenization sweep complete; CI guard (`scripts/check-brand-tokens.mjs`, present) in place. Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin), tracked not gated. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts` (verified present). Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01).** `ensureLive()` throws unless `RPC_TRADE_ESCROW_ADDRESS` set; `/api/trade-chain/*` return 503; `/dashboard/trade-hub` `notFound()`s via `TradeHubClient.tsx` (verified present). 8 in-code stub TODOs persist (§5b). | Medium (shelved) | Large |
| — | Top Shot in-app bulk-buy execution — blocked by the Dapper co-signer wall (same class as Cart / Trade Hub). Intelligence (detector + planner) shipped instead. | Low (external block) | n/a |

### Net-new features not in the numbered list

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Test-coverage infrastructure | **Shipped (07-12)** — vitest coverage + CI ratchet. Worth a numbered slot / a `CLAUDE.md` note. | n/a (shipped) | Medium |
| Bulk-buy intelligence + Hot Floors | **Shipped** — floor-sweep detector, set-completion planner, Hot Floors, honest floor pricing. | n/a (shipped) | Medium |
| Challenges feature | **Shipped** — `searchChallenges` ingest + `get_active_challenges` (31 live) + `rpc-set-challenge-roi` artifact. | n/a (live) | Medium |
| Alert-funnel consolidation | **Shipped** — retired legacy mis-route to canonical outbox; unified admin token. | n/a (shipped) | Medium |
| Concierge combo-subscriptions | **Shipped (07-11)** — `manage_deal_subscriptions` + team/badge serial filters + squeeze FMV totals + cheap-pack EV fix. | n/a (live) | Medium |
| Omni-channel alerts / Rewards | LIVE — dialing in. Non-code blockers on Rewards: store stocking; raffle legal review. | n/a (live) | Medium |
| Candy chain-two / Panini | Inert prebuilds — see §2.8 / §5g / §5h. | n/a (gated) | Medium |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter. (`funnel_events` follows the safer pattern — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID); migrate when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos ~5.5%, TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`.

### Architecture note worth tracking

- **Watchlist + FMV Alerts — the legacy path is now partly retired.** The 07-12 alert-funnel consolidation retired the legacy `fmv_alerts` `/api/cron/check-alerts` mis-route; the live alerts feature is the separate `alert_subscriptions` / `notification_channels` / `lib/alerts.ts` implementation (verified present). The old watchlist tables `CLAUDE.md` flags as partially decommissioned should be reconciled before any reactivation.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **OBSOLETE / recommended CLOSED.** The 2026-07-07 re-scope confirmed `api2.flowty.io` is ALIVE and the listing-cache pipelines are LIVE ingest; the teardown premise is void. Keep the caches; formally close the priority in `CLAUDE.md`. | §2.6 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced this week** via bulk-buy intelligence + Hot Floors, the challenges feature, concierge gap-closure, A1 owner-display completion, +3 `/insights` surfaces, and the test-coverage infrastructure. | §2.2 + §2.3 + §2.4 |

*Implicit priorities surfaced and still un-promoted:* **(a) activation/conversion + its measurement** (§2.1 — ≈13 users; machinery now includes combo alert subscriptions + a challenges surface, all unmeasured); **(b) cost + storage right-sizing** (§2.6 — Vercel family + DB now ~11 GB after +~2.9 GB in a week; set the Spend-Management cap regardless, decide a retention posture, and REINDEX/DROP the bloated wmc index); **(c) the autonomous-tooling reliability** (§2.6 — the bash/git sandbox failure has blocked night-pass shipping two nights running). All arguably worth promoting to explicit `CLAUDE.md` actions.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** This is why §1 reports 0 active revenue-blocking items. (`stripe@^22` is in `package.json` but dormant.)

---

## 5. In-code TODO inventory

A first-hand scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`, substring match on `TODO|FIXME|HACK|XXX` to also catch the `TODO_N`-style named placeholders) returned **71 raw matches across 42 files**. Excluding **3 hard false positives** and **9 descriptive test-file references** (both explained in §8) leaves **59 real actionable markers across 34 files** — **−6 vs last week's 65.** Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest single cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.8. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files) — unchanged

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs, fronted by `ensureLive()` so they throw rather than return fake tx ids.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI shows `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup — NOW FULLY IMPLEMENTED (0 markers) — **−3 this week (cluster resolved)**

- `supabase/functions/special-serial-sweep/index.ts` — **all four collection legs now resolve owners.** Last week 3 stub markers remained (AllDay / Golazos / UFC `console.log` no-ops); this week (07-12) they were implemented via `lookupOwnerFromWmc` (wallet_moments_cache denorm, "Verified data path 2026-07-12"). The file now has **zero** TODO/FIXME/HACK/XXX markers (verified by a targeted scan of the whole `supabase/functions/` tree, which returned none). See §3 (A1) — this is the marquee debt cleanup of the week.

### 5d. Pipeline calibration / migration (1 marker, 1 file) — **−2 this week**

- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder. **Still present.**
- ~~`workers/topshot-moments-hydrator/index.ts:317`~~ — **RESOLVED** (`TODO(supabase-migration)` gone; the `replace_topshot_moments_batch(payload jsonb)` RPC landed — line 317 is now the end of the editions-map fn).
- ~~`lib/fast-break-optimizer.ts:119`~~ — **RESOLVED** (`TODO(captain-bonus)` gone; line 119 is now a tiebreak `join`).

### 5e. Smaller data-quality / polish TODOs (3 markers, 3 files) — **−1 this week (one relocation)**

- `components/collection/CollectionMomentTable.tsx:730` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. **(RELOCATED** from `app/(collections)/[collection]/collection/page.tsx:2662` — the moment table was extracted into this component during the monolith refactor; same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `scripts/ingest-topshot-active-listings.mjs:126` — `TODO: set the real dapper.market listing URL once its format is confirmed.`
- ~~`app/(collections)/[collection]/pack/[id]/page.tsx:26`~~ — **RESOLVED** (`TODO(og-image)` gone; the `/api/og/pack/lifecycle` share card was built — line 26 now documents the implemented OG image).

### 5f. Cadence test coverage gap (2 markers, 1 file) — unchanged

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

### 5g. Candy / Solana chain-two discovery placeholders (17 lines, 3 files) — unchanged; **July-8 gate now passed**

The inert chain-two prebuild wraps **5 named discovery placeholders** unfillable until Candy secondary trading opens:

- `lib/chains/solana/normalize.ts` (14 lines — `:5,10,27,29,31,33,35,37,39,40,64,158,162,166`) — the `DISCOVERY TODOs` block: `TODO_1` (Metaplex Core collection mint → `CANDY_MLB_COLLECTION_ADDRESS`), `TODO_2` (Magic Eden symbol → `CANDY_MLB_ME_SYMBOL`), `TODO_3`/`TODO_4` (serial / edition-size attribute keys), `TODO_5` (stable per-edition key), plus the `.startsWith("TODO_")` route-guard checks.
- `app/api/ingest/candy-editions/route.ts` (`:8`, `:72`) + `app/api/candy-sales-indexer/route.ts` (`:111`) — inert-ingest notes that short-circuit the routes until the placeholders are filled.

→ Intentional, gated debt. The routes write nothing while the placeholders are unfilled. (Note: the 07-12 test-coverage work added vitest assertions that these guards return false while the TODOs are unfilled — see §8; those test references are counted separately, not here.)

### 5h. Panini WC2026 Prizm "Plane-A" discovery placeholders (10 markers, 6 files) — unchanged

The inert Panini WC2026 Prizm ingest scaffold — repo-only, writes nothing — wraps a per-mode discovery capture not yet performed:

- **Live scaffold (5 markers, 3 files):** `lib/chains/panini/feed.ts` (lines 64, 70, 80 — `TODO(go-live discovery)` for the CryptoSlam NFT API contract + the `/onepanini` request format), `app/api/cron/panini-circulation-refresh/route.ts:107` and `app/api/cron/panini-fmv-recalc/route.ts:82` (both `TODO(go-live)` short-circuit notes).
- **Reference drafts under `docs/drafts/panini/` (5 markers, 3 files):** `ingest-panini-runner.mjs` (lines 16, 29, 33), `panini-ingest-route.ts:137`, `panini-proxy/index.js:19`.

→ Intentional, gated debt — the same shape as the Candy block (§5g). Do **not** wire a cron / watchlist until a discovery capture lands.

> **Net change since last week:** **−6 real markers / −4 files** (65/38 → 59/34). All three drops are *resolutions*, not relocations: §5c special-serial-sweep 3→0 (AllDay/Golazos/UFC implemented), §5d 3→1 (hydrator batch RPC + fast-break captain-bonus both landed), §5e 4→3 (pack-lifecycle OG card built). The §5e `team_name` marker *relocated* (collection page → `CollectionMomentTable.tsx`) during the monolith refactor but persists. The §5a/§5b/§5f/§5g/§5h clusters are content- and line-identical to last week.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — DSN set), #3 (Flowty event indexer — reclassified, Flowty *frontend* shut but API alive), #4 (Pinnacle FMV — resolved + per-render engine), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — `lib/warmup/WarmupContext.tsx` prefetches `/api/packs`, verified present), #7 (AllDay `unmapped_sales` — resolver rewritten; V1-budget *drift* is the separate LOW operator item), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed this week:**
- **A1 special-serial owner display — COMPLETE across all four collections** — the AllDay/Golazos/UFC legs of `special-serial-sweep` were implemented via `lookupOwnerFromWmc` (07-12); the §5c cluster dropped 3 → 0.
- **`topshot-moments-hydrator` batch-RPC migration landed** — `replace_topshot_moments_batch` built; §5d dropped one marker.
- **`fast-break-optimizer` captain-bonus TODO removed** — §5d dropped another.
- **Pack-lifecycle OG-image card built** — `/api/og/pack/lifecycle`; §5e dropped one marker.
- **Test-coverage infrastructure — SHIPPED** (vitest route+lib coverage, jsdom component harness, `_shared` edge-fn extraction, CI ratchet). A new durable convention.
- **Top Shot bulk-buy intelligence + Hot Floors + honest floor pricing — SHIPPED** (floor-sweep detector, set-completion planner, Hot Floors tab, real-floor cost-to-complete, `edition_offers` ask-floor widening).
- **Alert-funnel consolidation — SHIPPED** (legacy `fmv_alerts` mis-route retired to the canonical outbox; unified admin token; ops alerts on red health). Operator: remove the orphan `/api/cron/check-alerts` cron entry.
- **pg_cron heavy-job timeout — FIXED (the real one)** — dedicated `cron_heavy` role, 600s per-role default (the inline-timeout migration had been inert).
- **Challenges feature + concierge gap-closure — SHIPPED** (`searchChallenges` ingest + `get_active_challenges` + `rpc-set-challenge-roi`; `manage_deal_subscriptions` + team/badge serial filters + squeeze FMV totals + cheap-pack EV fix).
- **Monolith refactor — advanced hard** — collection −1,341 / sniper −479 lines via component extraction.
- **+3 `/insights` surfaces** — `parallel-premiums`, `market-pulse`, `set-completers` (hub now 28).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation, cost/storage, and now *tooling reliability* promoted:

1. **Restore the autonomous tooling (§2.6, bash/git sandbox).** Highest operational leverage — the night pass has been unable to push code for two consecutive nights; fixing the sandbox provisioning restores autonomous shipping + likely the monitor inbox. Operator/infra.
2. **Measure the activation machinery you've built (§2.1).** Cheapest, highest product leverage — confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop, the alerts loop (now with combo subscriptions), and the new challenges surface; open alerts to the allow-list; watch whether SEO impressions + signups move off zero.
3. **Right-size cost + storage (§2.6) — the clearest financial line.** Do the Spend-Management cap backstop regardless; decide a retention posture for the deep-history/subedition data (DB ~11 GB, +~2.9 GB in a week); REINDEX-or-DROP the bloated wmc index.
4. **Let the FMV-correctness + subedition work soak (§2.3).** Watch the subedition/deep-history backfill converge; keep the per-collection `*_fmv_stale_hours` tripwires in the weekly check; finish PIN-FMV-REKEY waves 2/3; confirm the new A1 owner-resolution `unresolved` tally trends down as backfill widens.
5. **Clear the small operator items (§2.6).** Remove the orphan `/api/cron/check-alerts` cron entry; re-measure the classify-acq leg after the studio backfill finishes; wire (or classify) ALLDAY-V1-UNMAPPED-DRIFT; wire the `refresh-conflated-editions` daily-guard cron.
6. **Resolve the Candy July-8 gate (§2.8 / §5g).** Confirm whether ≥30 days of Candy Solana sales history materialized; if yes, that's the trigger to fill the 5 discovery placeholders and start chain-two; if not, leave inert.
7. **Formally close Priority #1 (Flowty, §4)** — record the keep-the-live-caches decision in `CLAUDE.md` (the teardown premise is obsolete).
8. **Chain-foundation cleanup as capacity allows (§2.8 / §5a).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` trap). Panini stays inert until a discovery capture. **Refresh `docs/overnight/focus.md`** (19 days stale).
9. **Page/brand tail (#17, #11) and the remaining `/dashboard` migration (#10, now 2,360 lines).** Lowest priority (note #14's two real monoliths shrank substantially this week).

---

## 8. Notes from verification

- **Git was NOT available this run (sandbox down).** No `git log` / commit count — the `useradd: exit status 12` sandbox-provisioning failure (the same one the 07-12 and 07-13 overnight passes hit) blocked all git access. The "what shipped this week" narrative therefore rests on `CLAUDE.md`'s Recent-Sessions entries (07-11, 07-12, 07-13) + `docs/overnight/metrics-latest.json` + first-hand file reads — **not** a diff. Prod HEAD per `metrics-latest.json` = `2d57889f` READY (challenges `searchChallenges` ingest scheduler).
- **Line counts** were taken with a ripgrep per-line count (the `$`-anchor trick), cross-validated against last week's `wc -l` figures — `analytics/page.tsx` returned exactly **495** and `lib/blazers-trivia.ts` exactly **198**, both matching last week, which validates the method. Verified: `app/dashboard/page.tsx` **2,360** (UP 347 from 2,013) · `collection/page.tsx` **1,529** (DOWN 1,341 from 2,870) · `sniper/page.tsx` **1,712** (DOWN 479 from 2,191) · `analytics/page.tsx` **495** (unchanged) · `blazers-trivia.ts` **198** (unchanged).
- **Stale figure carried — the analytics monolith.** `CLAUDE.md` #14 still lists `analytics/page.tsx` at ~2,128/2,208 lines; the actual `/analytics` page is **495 lines** (already split). This week the two *genuine* monoliths also shrank — `collection` 1,529 and `sniper` 1,712 — so `CLAUDE.md` #14's "collection ~2,900 / sniper ~2,070" is now also stale. Recommend correcting #14.
- **TODO scan: 71 raw matches / 42 files → 59 real markers / 34 files** (after excluding 3 hard false positives + 9 descriptive test references). **−6 vs last week's 65.** By cluster: 18 chain-rename shims (§5a) · 8 Trade Hub stubs (§5b) · **0** special-serial-sweep (§5c, was 3 — RESOLVED) · **1** pipeline-calibration (§5d, was 3) · 3 smaller polish (§5e, was 4) · 2 Cadence-test gap (§5f) · 17 Candy/Solana placeholders (§5g) · 10 Panini placeholders (§5h) = 59.
- **Three TODO-scan matches are hard false positives** (same as last week): `lib/format.ts:6` — `XXX` inside `"$X,XXX.XX"`; `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside `audit_2026XXXX_...`; and `supabase/migrations/20260624162548_recover_golazos_video_url_from_thumbnail_key.sql:6` — `XXX` inside `numeric_numeric_recXXX`. Excluded from the 59.
- **Nine matches are descriptive test-file references (NEW this week)** — introduced by the 07-12 test-coverage work: `__tests__/api-candy-sales-indexer.test.ts` (:7, :44), `__tests__/api-ingest-candy-editions.test.ts` (:9), `__tests__/api-wallet-backfill-candy.test.ts` (:22, a fixture setting the `TODO_1_...` placeholder), `__tests__/panini-feed.test.ts` (:7, :80, :85), `__tests__/solana-normalize.test.ts` (:103, :104). These are vitest assertions that the Candy/Panini placeholder guards behave while unfilled — they reference the gated placeholders but are **not themselves actionable markers**, so they're excluded from the 59 (even if counted, they resolve automatically when Candy/Panini go live).
- **The four "missing" markers were confirmed genuine removals, not scan gaps** — each file was read directly at the relevant line: `special-serial-sweep/index.ts` (AllDay/Golazos/UFC legs now `lookupOwnerFromWmc`), `workers/topshot-moments-hydrator/index.ts:317` (now the end of the editions-map fn), `lib/fast-break-optimizer.ts:119` (now a tiebreak join), and `app/(collections)/[collection]/pack/[id]/page.tsx:26` (now documents the built OG card). A whole-tree scan of `workers/` and `supabase/functions/` returned zero markers.
- **`/insights` surfaces: 28** — verified by `INSIGHT_ROUTES` in **`lib/sitemap-data.ts`** (28 entries) and the `app/insights/` dir (28 surface `page.tsx` + the hub), which agree. **+3 since last week's 25:** `parallel-premiums`, `market-pulse`, `set-completers`. (The sitemap source moved from `app/sitemap.ts` to `lib/sitemap-data.ts` this week — the old path no longer exists.)
- **No active freeze.** `docs/FREEZE.md` verified absent.
- **`docs/overnight/focus.md` is 19 days stale** (dated 2026-06-24) — worth a refresh.
- **Cited-path spot check (all via Grep/Read — Glob was unreliable this run):** all expected-present paths verified present — `app/api/profile/verify-challenge/check/route.ts` (#0), `lib/chains/flow/cadence/purchase-moment.ts` (#1), `app/dashboard/trade-hub/{TradeHubClient,TradeChainPanel}.tsx` + `lib/trade-escrow/fcl-submit.ts` (#3), `supabase/functions/special-serial-sweep/index.ts` (A1), `lib/warmup/WarmupContext.tsx` (#6), `scripts/scan-historical-storefront.mjs` (#9), `scripts/check-brand-tokens.mjs` (#11), `lib/blazers-trivia.ts` (#12), `docs/audits/refactor-plan-monolith-pages-2026-05.md` (#14), `docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md` (#17), `.github/workflows/ci.yml` (#16), `lib/alerts.ts` + `lib/collections.ts`, `docs/reference/schema-truth.md`, `docs/cleanup-decisions-2026-06-01.md`, `docs/handoff-2026-07-13-overnight-pass.md`, and `lib/chains/{panini/feed,solana/normalize}.ts`. Intentionally-deleted paths remain correctly absent: `scripts/cleanup-storefront-wallets.mjs`, root `cleanup.cdc`, `components/PinnacleSniper.tsx`.
- **DB-side facts** (FMV counts, editions counts incl. TopShot 19,241, DB size 11,044 MB, trust breaches [], security 0/0/0/0, sentinel 0, `impossible_parallel` 1, `edition_integrity` 4, Pinnacle `fmv_stale` 22h) are read from **`docs/overnight/metrics-latest.json` (captured 2026-07-13T08:11Z — same-day, fresher than last week's day-old metrics)** + `CLAUDE.md`'s 07-13 overnight entry. They were **not independently re-queried** against production Supabase this run (bash/git down), consistent with prior reports. Health read GREEN per the 07-13 pass.
- **The Glob tool was unreliable this run** — it returned false "No files found" for paths that provably exist (e.g. `lib/chains/flow/cadence/purchase-moment.ts`). All existence checks were done with Grep (100% reliable this session) or Read (definitive). Noted so a future run doesn't trust a Glob "absent" here.
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-07-13)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev "Sign in with Dapper" blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant (present) |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired; 0 unresolved/24h |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty indexer resolved (frontend shut, API alive); Trade Hub shelved + guarded | `ensureLive()` + 503 routes + `TradeHubClient.tsx` (present) |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary | `pinnacle_fmv_history` (live) |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` present, prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** (V1-budget *drift* is the separate LOW operator item) | `CLAUDE.md` + ledger |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — `scan-historical-storefront.mjs` present (manual); `cleanup-storefront-wallets.mjs` + `cleanup.cdc` correctly absent | Grep verified |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,360** lines (UP 347 this week) | ripgrep line-count |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — theme sweep complete; CI guard present | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | line-count |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open — advanced hard this week** — collection **1,529** (−1,341) / sniper **1,712** (−479); **analytics figure STALE (actual 495, already split)** | line-count + dir |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — blocking** | `.github/workflows/ci.yml` present |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — Hot Floors + honest floor pricing + Trophy Case polish landed this week** | audit docs present; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **test-coverage infrastructure**, **bulk-buy intelligence + Hot Floors**, **challenges feature**, **alert-funnel consolidation**, **concierge combo-subscriptions**, **omni-channel alerts**, and **Rewards** features, the 3 new `/insights` surfaces, and the gated Candy + Panini chain prebuilds.

**Bottom line for `CLAUDE.md`:** the known-issues numbering is unchanged from last week and several recurring recommendations still stand: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **give the live test-coverage infra, bulk-buy intelligence, challenges feature, alerts + Rewards features numbered slots**; (c) Prioritized Action #1 (Flowty) can be **closed** — the teardown premise is obsolete (keep the LIVE caches); **(d) correct the #14 line counts** — analytics is ~495 (already split) and this week collection dropped to 1,529 / sniper to 1,712; (e) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 chain-rename shims, the 17-line Candy block, and the 10-line Panini block are intentional debt worth a one-line note; **(f) the A1 note can be fully closed** — special-serial owner display now resolves for all four collection legs (TopShot via `getMintedMoment`, AllDay/Golazos/UFC via wmc). And, as every recent report has said: given ≈13 users and a growing stack of live-but-unmeasured activation machinery, **promote activation + its measurement**, **cost/storage right-sizing** (DB ~11 GB), and — newly this week — **the autonomous-tooling reliability** (the bash/git sandbox failure has blocked night-pass shipping two nights running) to top-line priorities.
