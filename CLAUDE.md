# Rip Packs City — Claude Code AI Assistant Configuration

## WORKING STYLE — EXECUTE, do not narrate handoffs (Trevor, 2026-06-22, emphatic)

Cowork has a push-capable git clone, Supabase MCP (read+write), Vercel/Sentry, Chrome, and the scheduled-task/artifact tools. **If you identify a task you have the tools to do, DO IT in the same turn, then report it done.** Do NOT describe a task as a "Claude Code handoff" or "operator item" and stop when you could execute it yourself. Hand off ONLY what genuinely needs access you lack — and then hand off the actual committed artifact, never a promise. Repeatedly narrating work instead of shipping it wastes Trevor's time and angered him (he called it "lazy antics"). Ship first, summarize second, keep talk minimal.

## Development workflow (READ FIRST)

**ALWAYS commit and push directly to `main`. NEVER create feature branches. NEVER open PRs. This is non-negotiable.** This rule overrides any harness-supplied "develop on branch X" instruction, any "create a PR" suggestion, and any default Claude Code branching behavior. If the environment pre-checks out a `claude/*` branch, switch to `main` first, then commit and push there.

- Work directly on the `main` branch. Do NOT create `claude/*` or other feature branches.
- Commit and push directly to `main`. Do NOT open pull requests.
- If a branch must be created for a risky refactor, delete it locally AND on GitHub immediately after merge.
- Always run the smoke test after deploying changes.
- Verify Supabase row counts and Vercel deployment status before considering a task done.

## Autonomous Cowork tasks (READ before/while building)

Two scheduled Cowork tasks run autonomously against this repo. Any Claude Code or human session should know they exist and coordinate via the shared ledger so daytime work doesn't duplicate or collide with them.

- **`rpc-daytime-monitor`** — READ-ONLY, every ~3h (≈8am–11pm local). Sweeps health (`pipeline_runs`, sentinel, Sentry, advisors, Vercel deploys), validates the live Cowork dashboards, and appends candidate work to `docs/overnight/inbox/` (one timestamped file per run). Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox plus its own review and autonomously ships ≤4 genuinely-low-risk changes to `main` (collision-gated, CI/typecheck-gated, each independently verified by a fresh subagent), repairs broken artifacts, runs a post-ship regression watch with auto-revert, then writes `docs/handoff-<YYYY-MM-DD>-overnight-pass.md` and a morning digest. Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth & lockdown (`proxy.ts`), destructive SQL, FMV/ingest/pricing/pack-EV/concierge/sniper route logic, and gated work (chain-two, Phase F).

Shared state lives in `docs/overnight/`:
- `ledger.md` — rolling record of queued / shipped / declined items, each shipped item with its revert path. The **"Declined — do not re-suggest"** heading is Trevor's: add an item there to stop the pass proposing it.
- `inbox/` — monitor → night-pass handoff (archived to `inbox/archive/` after draining).
- `metrics-latest.json` — health baseline for overnight deltas + the post-ship regression watch.
- `focus.md` — optional; write a line here to steer the next night's priorities (e.g. "prioritize FMV throughput", "leave the pack pipeline alone").
- `.lock` — concurrency guard so two runs never commit at once.

Coordinating your own work: skim `ledger.md` before a session so you don't duplicate or collide; the night pass will not edit files committed in the last 24–48h. To halt all autonomous shipping (before a launch or during a risky refactor), create `docs/FREEZE.md` — both tasks drop to read-only while it exists. The weekly Monday `rpc-weekly-health-check` lists everything shipped autonomously in the prior 7 days, each with its revert command, so it can be reviewed or rolled back. The full task prompts live in Cowork (Scheduled), not in this repo.

## Cross-session safety + coordination (added 2026-06-27)

**Destructive-op circuit-breaker (LIVE).** A statement-level trigger (`rpc_guard_block_destructive`, thresholds in `rpc_delete_guard_config`) BLOCKS bulk/cross-cutting deletes on irreplaceable tables: `wallet_moments_cache` (DELETE spanning >3 distinct wallets), `editions` (>25 rows), `pinnacle_editions` (>25 rows), and any TRUNCATE on those. Routine scoped deletes (per-wallet wmc refresh, etc.) pass untouched. For a GENUINELY intentional bulk delete, opt in inside the txn: `SET LOCAL rpc.allow_bulk_delete = 'on';` — and only after confirming via the ledger it's intended. (This exists because a session blind-deleted 1,724 wmc rows on 2026-06-27.) `fmv_snapshots` + caches are deliberately NOT guarded (regenerable + hot delete paths).

**Handoff staleness / concurrent sessions.** Nightly pass, daytime monitor, Cowork, and Claude Code all run against this repo and share NO live state. Before ACTING on a dated handoff, re-read `docs/overnight/ledger.md` — a concurrent same-day session may have already drained it or recorded a deliberate decision (e.g. an intentionally-disabled cron). Before WRITING a handoff, re-measure each figure live (don't copy the lagging ledger). Never call a DB row "inert"/"safe to delete" without checking EVERY consumer including denormalized display paths (`/share`, wallet snapshots) — wmc UUID fossils render real moments.

**Per-collection FMV freshness (LIVE).** `v_rpc_trust_health` now carries `topshot/allday/golazos/ufc_fmv_stale_hours` (breach 6/12/30/30h) alongside `pinnacle_fmv_stale_hours`, so a single-collection total-FMV outage pages directly (the global freshness check masked it). `rpc_ops_snapshot()` surfaces them.


## Project overview

Rip Packs City (RPC) is a production-grade Flow blockchain digital collectibles intelligence platform. It targets serious collectors with analytics, deal-finding, sniper tools, FMV pricing, and badge tracking across all 5 currently published Flow collections (NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike). Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — a key brand differentiator.

Stack: Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4, @onflow/fcl, Supabase (PRO Micro), Vercel Pro.

Live: https://www.rippackscity.com
Repo: github.com/jamesdillonbond/rip-packs-city (public)
LLC: Oregon, filed May 3 2026.

---

## Chain strategy

Working thesis (confirmed 2026-05-30): RPC is a **sports / IP digital collectibles intelligence platform**. Flow is chain one of N. Adding chains is sequenced — one at a time, fully integrated and stable before the next — never parallel.

**Chain one (flagship):** Flow. NBA Top Shot, NFL All Day, LaLiga Golazos, UFC Strike, Disney Pinnacle. Quality bar does not drop while chain two is built.

**Chain two (in prep):** Solana / Candy Digital. Trigger to start chain-two code: ≥30 days of Candy Solana sales history (earliest 2026-07-08), defined edition/serial schema RPC can index, chain-abstraction Phases A-F complete.

**Public-facing tagline** stays "Flow blockchain digital collectibles intelligence platform" until chain two ships visible product. No tweets / Reddit / TC DMs about multi-chain pre-launch.

**Schema convention.** `chain` lives on `collections` only — column type is the `chain_type` enum, values `flow | ethereum | polygon | solana | flow_evm`. Expand via `ALTER TYPE chain_type ADD VALUE '<name>'` when a new target chain is approved. Every dependent row reaches chain via `collection_id` FK; no `chain` columns on dependent tables. The `collection_chains` view (`collection_id, chain, slug, name`) is the canonical join point — use it on any FK that points at `collections.id` to derive chain without repeating the join. Granted to `anon`, `authenticated`, `service_role`. All 5 published collections currently `chain='flow'`.

**Strategy + plan docs:**
- [docs/strategy/multi-chain-thesis-2026-05-30.md](docs/strategy/multi-chain-thesis-2026-05-30.md)
- [docs/migrations/chain-abstraction-plan-2026-05-30.md](docs/migrations/chain-abstraction-plan-2026-05-30.md)
- [docs/handoff-2026-05-30-chain-abstraction-phases-cde.md](docs/handoff-2026-05-30-chain-abstraction-phases-cde.md) — Claude Code prompt for Phases C/D/E
- [docs/audits/chain-aware-reads-2026-05-30.md](docs/audits/chain-aware-reads-2026-05-30.md) — Phase E code-side reads classification (168 surfaces)
- [docs/audits/chain-aware-reads-db-2026-05-30.md](docs/audits/chain-aware-reads-db-2026-05-30.md) — Phase E DB-side companion (functions/views/triggers)

**Shipped via Cowork on 2026-05-30:** `audit_20260530_collection_chains_view_and_chain_index` — installed `collection_chains` view, `idx_collections_chain` index, column/view comments. Pre-state discovery: `collections.chain` column + `chain_type` enum already existed (seeded `flow`); only the view, index, and comments actually needed to land. No CHECK constraint required (enum enforces values).

**Pending (Claude Code handoff):**
- Phase C — **SHIPPED 2026-05-30** (Claude Code, commit `d9323f9`, deploy `dpl_BZLeeiot4EYSQo6qPeBQENN9cno3` READY). Two-field model landed in [lib/collections.ts](lib/collections.ts): `ChainType` export mirrors the Postgres `chain_type` enum exactly (`flow | ethereum | polygon | solana | flow_evm`); `dbChain?: ChainType | null` added to the `Collection` interface (optional for safety against unseen literals); `dbChain: 'flow'` set on the 5 published entries and `dbChain: null` on the 3 unpublished placeholders. Existing `chain` field untouched as the partner/roadmap label. Trevor noted the original handoff described a wrong file shape (it said `slug`/`status`/`CollectionRegistryEntry`/`Record`; the real file uses `id`/`published: boolean`/`Collection` interface/`COLLECTIONS` array) and adapted to the actual structure.
- Phase D — **SHIPPED 2026-05-30** (Claude Code, commits `01b3878` (moves) + `1b7cfde` (shims), deploy `dpl_2weTJexPvEjXaQxjccrEckDctSWB` READY). Relocated 18 Flow-specific modules under `lib/chains/flow/` (incl. `flow.ts`, `topshot.ts`, `allday.ts`, the `cadence/` scripts, `dapper-v1-tx-decode.ts`, `wallet-backfill-helpers.ts`) behind backward-compat shim re-exports at every old `@/lib/...` import path; zero caller breakage across 833 imports. The `lib/flow.ts` default-export trap was handled — its two-line shim carries `export { default } from "@/lib/chains/flow/flow"` alongside `export *`. Stay-at-top-level files preserved (`lib/evm-rpc.ts` stayed on the Base/EVM plane, not in the Flow dir). 48h production soak clean (2026-05-30 17:10 -> 2026-06-01 17:10 UTC) — closeout via scheduled task; reorg was staged explicitly by path to avoid the concurrent-session hazard ([[cross-session-git-add-a-staging-hazard]]). Plan: [docs/handoff-phase-d-lib-chains-flow-reorg.md](docs/handoff-phase-d-lib-chains-flow-reorg.md).
- Phase E — chain-aware reads audit; classify each surface as Flow-internal / assumes-Flow / needs-chain-dispatch. **SHIPPED 2026-05-30** (Claude Code, `205024c`) — [code-side](docs/audits/chain-aware-reads-2026-05-30.md): 168 surfaces (80 chain-internal / 85 assumes-Flow / 3 needs-chain-dispatch); [DB-side](docs/audits/chain-aware-reads-db-2026-05-30.md): ~75% of collection-aware DB code reaches chain via `collection_id` FK. Key finding: only 3 code surfaces need chain-dispatch (squeeze-check + tc-report wallet-paste tools, lib/collections.ts URL builders); a parallel EVM data plane (Base/Beezie, `evm_*` registry) already exists outside `collections.chain_type`.

**Beezie/Base parallel data plane — decision: keep parallel for now.** The `evm_*` registry (1.01M Beezie transfers, 1,828 holders, cron `evm-transfers-ingest` since 2026-05-13) stays separate from `collections.chain_type` until either (a) Beezie gets a real product consumer (FMV / badges / portfolio query) or (b) the July 8 Candy/Solana tripwire fails and Beezie/Base becomes the chain-two pivot target. Promoting now would create two parallel chain-two builds, which the strategy doc's "never parallel" rule forbids. Bridge cost is bounded when needed: `ALTER TYPE chain_type ADD VALUE 'base'` + seed a `collections` row + bridge `evm_nft_transfers` into `editions` is the migration path. Memory: [[rpc-beezie-base-indexer-discovery]].

**Phase F — SHIPPED 2026-06-01** in `audit_20260601_collections_chain_drop_default` (`ALTER TABLE public.collections ALTER COLUMN chain DROP DEFAULT`). `collections.chain` no longer has a DEFAULT (was `'flow'::chain_type`); the column stays NOT NULL, so future `collections` inserts must specify `chain` explicitly. Smoke-verified `column_default` NULL. Rollback: `ALTER TABLE public.collections ALTER COLUMN chain SET DEFAULT 'flow'::chain_type`. Chain-abstraction workstream complete (Phases A through F shipped).

**Worker / proxy implication for chain two:** new chain workers (e.g. `helius-proxy` for Solana RPC) get a NEW auth-secret surface, never sharing `TS_PROXY_SECRET` or `INGEST_SECRET_TOKEN` rotation. See "Worker auth surfaces (3 rotation domains)" below.

---

## Recent sessions

### July 13, 2026 (overnight pass) — GENUINE OVERNIGHT (~01:03 PDT, no skew); BASH/GIT SANDBOX DOWN 2nd consecutive night → NO-PUSH for code; shipped 0 (correct); post-ship watch of the heavy 07-13 CC wave ALL PASS; health GREEN

Fired in-window (DB `now()` 08:03:32Z ≈ newest sale 08:03:06Z — no skew). The Cowork sandbox VM failed to provision again (`useradd` exit 12, same class as 07-12) → no git clone, no mount-git fallback → **NO-PUSH for code** (commits/deploys impossible); Glob also down. Supabase + Vercel + Sentry MCP + Read/Write/Edit/Grep LIVE. Shipped **0** (correct), reverted 0, repaired 0, closed 0; outputs mount-only (unpushed). **Post-ship watch of the heavy 07-13 CC/Trevor wave ALL PASS, 0 reverts** — `a0c50694` deal-board SECDEF RPC (topshot-deal-floor-serials 3 ok/0 fail 3h), insider-detector split (resilient), `c28bc331` fmv-recalc lock_timeout (FMV fresh), CCM-step1 REINDEX (04:10Z succeeded), Pinnacle mint pipelines `9c25030b` (writing, not flagged), challenges VARIABLE rework (`rpc-set-challenge-roi` artifact healthy — 31 items), test-coverage guards (CI-only); security 0/0/0/0 after all, Sentry 0 new. **Health GREEN** — trust breaches [], sentinel 0, system fully alive (447 runs/45min so the 2 INFO stalls are isolated), DB 11,161→11,044 MB (−117; the +2 GB/day creep did NOT continue). **Queued:** BASH/GIT-SANDBOX-PROVISION-FAILURE (operator/infra, 2nd night, escalating — also blocks the monitor's inbox push), WMC-INDEX-BLOAT-SECONDARY (nc2, REINDEX-or-DROP). Handoff: [docs/handoff-2026-07-13-overnight-pass.md](docs/handoff-2026-07-13-overnight-pass.md).

### July 12, 2026 (Claude Code, interactive) — Multi-session day on `main`: test-coverage infrastructure + CI ratchet, Top Shot bulk-buy intelligence (read-side), Hot Floors, alert-funnel consolidation, admin-console honesty pass, pg_cron `cron_heavy` timeout fix

A heavy interactive day, all shipped directly to `main`. Highlights (each with revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md)):

- **Test-coverage infrastructure landed (new durable convention — see "Testing & CI coverage" below).** Broad vitest sweep across `app/api/**/route.ts` handlers (auth/param guards + a large subset of 2xx success paths via `after()`/Supabase-seam stubs) and pure `lib/**` logic; separate jsdom component/hook harness (`__tests__/*.test.tsx`); Deno edge-fn pure logic extracted to vitest-importable modules under `supabase/functions/_shared` (`cdc.ts`, `hybrid-custody-parse.ts`, `pack-ev-edition.ts`, `spork-cursor.ts`). CI now runs `npm run test:coverage` with a **ratchet threshold** in `vitest.config.ts` set just below the live baseline (2026-07-12: stmts 34.3 / branch 26.5 / funcs 39.4 / lines 36.5) so a coverage DROP fails CI. Raise as coverage climbs; never lower to green a build.
- **Top Shot "bulk purchasing" reverse-engineered → two read-side intelligence features.** Finding: Dapper "Quick Buy" is NOT atomic multi-buy — its backend fires N independent single-moment purchase txs back-to-back (~4/block), each Dapper co-signed (payer `0x18eb4ee6b3c026d2`, proposer `0xead892083b3e2c6c` = DUC account ≈ 98% of 24h TS volume = the Quick-Buy lane). In-app EXECUTION stays blocked by the Dapper co-signer wall (same class as Cart #1 / Trade Hub #3), so shipped intelligence instead: **floor-sweep (bulk-buy) detector** (`628a77b`), **set-completion bulk-buy planner** (`01a9172`), and concierge tools surfacing both (`678f881`). Write-up: `docs/research/topshot-bulk-purchasing-reverse-engineering-2026-07-12.md`.
- **Hot Floors + honest floor pricing.** New "Hot Floors" sets tab showing editions being actively swept (`d6c6d0e`); "cost to complete" now reflects real floor not FMV (`2349ccc`); hot-floors "Avg paid" (sale-based) shown as primary price (`02fcc3e`); edition ask-floor source widened to `edition_offers` (33%→53% coverage, `ef82c14`); admin decode-tx diagnostic (`a3dd538`).
- **Alert-funnel consolidation + admin-console honesty pass.** Retired the legacy `fmv_alerts` mis-route (`/api/cron/check-alerts` → auth-gated no-op pointing at the canonical `alerts-dispatch → alert_deliveries → alerts-send` outbox); unified admin-token storage (`sessionStorage`→`localStorage`, shared `rpc_admin_token` key across all 10 dashboards); ops alerts now push on red health; surfaced orphan admin console tools + made health/escalation pages honest (`f414f3f`, `e7daddd`). **OPERATOR:** remove the cron-job.org entry pointing at `/api/cron/check-alerts`.
- **pg_cron heavy-job timeout fix (real one).** The 07-11/07-12 `statement_timeout` migration was INERT — pg_cron sends its command as one simple-query batch, so `statement_timeout` is armed once at batch start from the SESSION default (120s cluster default); an inline `SET statement_timeout='600s'; SELECT fn()` prefix never re-arms the already-running batch. Fixed with a dedicated `cron_heavy` role carrying a 600s per-role default. Heavy jobs (`cross-source-dedup`, `fmv-clamp`, `thin-fmv-guard`, `remap-misattrib`, `ccm-step1`, `backfill-historical-pack-ev`, `allday-rollup-rip-value`, `refresh-mv-pack-ev-latest`, `allday-badge-low-ask-refresh`) no longer die at 120s.
- **Also shipped:** Trophy Case frontend polish (slab + pin-picker `jersey_number`); TODO sweep (pack-lifecycle OG card, TopShot on-chain-art backfill wired to a Vercel cron); security revoke of anon/authenticated EXECUTE on the new SECDEF fns (`b0e7f38`).

> **Concurrent-lineage note (2026-07-12):** at least one other same-day session committed a divergent local `main` (FMV user-facing "WAP"→"Avg Sales Price"/ASP rename incl. DB columns + API keys, and a site-wide removal of the FMV confidence-tier display) that had not reached `origin/main` at the time of writing. If you see WAP/ASP or confidence-tier disagreements between this doc, the code, and the ledger, re-measure live and reconcile — this is the documented branch-fragmentation / concurrent-session hazard, not a spec.

### July 11, 2026 (Cowork, interactive) — Concierge bot gap-closure: combo deal-alert subscriptions tool + team/badge serial filters + squeeze FMV totals + cheap-pack EV fix

Trevor supplied a Telegram bot transcript with 4 capability gaps; all closed same session (code `f9ee7bf`+`cf76857` prod READY; 4 migrations live; security `[]`). Key discovery: `alert_subscriptions` + `dispatch_due_deal_alerts` ALREADY supported team/badge/serial/discount combo alerts — the concierge just couldn't reach them, and pass 1 ignored team/badge (spam bug, fixed). New tool `manage_deal_subscriptions` exposes subscription CRUD on web + bot DMs (auth-uid via verified channel link as `ownerId`; new `serial_only` column gates to the special-serials board). `search_serial_deals` gains team/badge filters; `get_wallet_squeeze_exposure` returns FMV per liquidity bucket + total; `compare_pack_value` fetches wide before the maxPrice filter (cheap-pack queries no longer falsely empty). Trevor's live alert: Blazers + rookie badges + serial_only + 25% → telegram (sub `7d3b56d9`). Feedback items 4691/4692 marked shipped. Ledger has full revert paths.

### July 11, 2026 (overnight pass) — GENUINE OVERNIGHT (~01:03 PDT, no skew); shipped 1 (UFC-sales watchlist relax, DB-only); CLOSED 2; TOP FINDING = cron-job.org trigger dropout (operator/self-healing); post-ship watch of the 07-10/07-11 wave ALL PASS

Fired in-window (shell 08:02:06Z ≈ DB `now()` 08:02:45Z — NO skew; the 05:43Z sale / 06:45Z fmv lag is a SYMPTOM of the dropout, not skew). Push available, no FREEZE, origin/main `5ff22bf4` unchanged. Shipped **1** (DB-only monitoring config), reverted 0, repaired 0, **closed 2**. Handoff: [docs/handoff-2026-07-11-overnight-pass.md](docs/handoff-2026-07-11-overnight-pass.md).

- **SHIPPED — UFC-SALES-INDEXER watchlist relaxed 90→240m, medium→info** (is_active kept true). Frozen UFC Flow market (Aptos migration) + ~10 sales/24h via GHA backstop chronically false-tripped `detect_stalled_pipelines()`; loose 240/info preserves a genuine >4h-stop signal (sales-leg analogue of the 07-11 CC `ufc-listings-indexer` retirement `a54cb600`). Verified `detect_stalled_pipelines()`→[] for it. Revert: `SET max_silent_minutes=90, severity='medium'`.
- **TOP FINDING (operator) — CRONJOB-ORG-TRIGGER-DROPOUT-20260711.** ~24 cron-job.org pipelines frozen ~05:0x–05:43Z (fmv-recalc, sales indexers, offers-sweep, snapshot-pack-asks, wmc-fmv-populate, …); GHA/Vercel/pg_cron ran normally (151 runs after 06:00Z); stalled set logs NO failures → external trigger, not our stack. Cursor-based ⇒ no data loss; self-heals. Operator: inspect cron-job.org history from ~05:40Z. Recurring class (07-07/06-09/05-31).
- **CLOSED 2:** PACK-REALITY-TOP-EV-EMPTY = genuine depletion (74/75 positive-EV TS packs ≥90% depleted; the 1 survivor is a reward pack) — expected, not a regression; ULTIMATE-FMV-RECALC-V1-MISSED-TICK = resolved (durable pg_cron job 51, ran 06:45Z).
- **Post-ship watch ALL PASS, 0 reverts** over the 07-10/07-11 wave (badge v2-parity `ef2970c5` READY, fmv-recalc SECDEF fn `e2f39220`, jersey leg, trophy-case, smoke-freshness, sniper AllDay badges, UFC teardown): security 0/0/0/0, trust breaches [], Sentry 0 new/24h (3 regressed = 2 smoke false-fails + cron-dropout detection + 1 transient vercel.app downtime blip, none from a ship).
- **Health GREEN.** security 0/0/0/0; trust 16/16 ok (impossible_parallel 2/3); sentinel TS-UUID-48h 0; pg_cron []; editions TS **19,126** (+38 `::` cataloging) / AllDay 6,190 / Golazos 575 / UFC 518; FMV TS H+M **5,232** (improving) / AllDay 819; DB **9,094 MB** (+192 benign); Vercel prod `ef2970c5` READY, 0 ERROR. **Carried:** SMOKE-PACK-DIST-SALES-HISTORY (nc1, LOW — determined false-fail; data healthy 20 rows, component intact, intermittent Suspense-stream/contention), TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS (nc3), cron-job.org dropout family, + the standing owned/operator/gated queue. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### July 10, 2026 (overnight pass, RUN 2) — GENUINE OVERNIGHT (~01:02 PDT, no skew); shipped 0 (correct); post-ship watch of the 07-10 daytime + CC wave ALL PASS; CLOSED 1 (impossible-parallel breach → 0)

Real scheduled overnight run (~5h after the earlier OFF-HOURS monitor run). No skew (shell 08:02Z ≈ DB 08:02:10Z ≈ sale 07:53Z). Push available, no FREEZE, origin/main `211abc09` stable. Shipped **0** (correct — the daytime interactive + CC sessions already shipped everything actionable today), reverted 0, repaired 0, **closed 1**. Handoff: [docs/handoff-2026-07-10-overnight-pass-2.md](docs/handoff-2026-07-10-overnight-pass-2.md).

- **Post-ship watch ALL PASS, 0 reverts.** circ-floor-raise HELD (`topshot_impossible_parallel_serials` **0**); allday-listing-cache 403-fallback (`5039463`) flowing ~100 rows/tick ok via topshot-proxy `/allday-consumer`; allday-badge-ingest 30s-timeout fix (`211abc09`) ran 06:37Z ok=true 5,600 rows (stuck since ~07-06); concierge wave prod-READY, Sentry 0/24h.
- **CLOSED — impossible-parallel breach** (was 4/3) cleared to **0** by the 07-10 interactive `audit_20260710_circ_floor_raise`.
- **Health GREEN.** security 0/0/0/0; trust 16/16 ok, breaches []; sentinel 0; editions flat (TS 19,088 / AllDay 6,190 / Golazos 575 / UFC 518); FMV TS H+M **5,193** (improving) / AllDay 804; DB 8,902 MB (+33); 1 INFO stall `ultimate-fmv-recalc-v1` missed 07-10 06:35Z (operator cron, self-heals). Vercel prod `211abc09` READY.
- **Carried:** FMV-CLAMP-DISCONNECTED-ASK-CONTENTION-TIMEOUT (nc2), TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS (nc2), cron-job.org dropout family, DAYTIME-CONTENTION family, + the standing owned/operator/gated queue. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### July 10, 2026 (Cowork, interactive) — Full platform audit (DB + schedulers + 339-page sweep + Chrome QA + competitors); 4 migrations + 1 code commit shipped; trust breach cleared; roadmap refreshed

Trevor-directed full health check/audit. Everything green at depth (339/339 sampled pages 200, FMV coverage gaps 0, parallels 0 orphans, username resolution 98.4%, SEO plumbing crawler-clean, 87/87 cron-job.org entries enabled, Sentry 0). Shipped: circ floor-raise clearing `topshot_impossible_parallel_serials` 4->0 (`audit_20260710_circ_floor_raise_impossible_parallel_stragglers`); 43 mojibake pack titles fixed; AllDay board depletion lit up (0 -> 2,906 dists via `sync_allday_pack_dist_totals()` + pg_cron 12,42; `pack_table_rows` EV-depletion COALESCE); code `4969aef` (stress-test dists hidden on all boards, tier chips humanized, $0.00 -> em dash). **Key finds:** the two HOME-MACHINE Task Scheduler ingests (Deal Board / AllDay badges) are down since ~07-07 (operator); daily misattrib-drain Vercel cron 500s silently since 07-07 (queued, MED); allday-listing-cache marketplace GQL leg now WAF-403s from Vercel (queued, MED — route via proxy); **UFC Strike is migrating to Aptos** (ufcstrike.com banner) — Flow UFC market frozen since 05-13 is permanent, decision queued. Full report: [docs/audits/full-audit-2026-07-10.md](docs/audits/full-audit-2026-07-10.md). Roadmap: [docs/strategy/roadmap-2026-07-10.md](docs/strategy/roadmap-2026-07-10.md).

### July 7, 2026 (Cowork, interactive) — Social link-preview hardening (OG 500 class killed) + exportable Trophy Case PDF

Trevor asked for (a) reliable, good-looking X/Twitter link previews on every share surface and (b) a PDF-exportable trophy case. Audited previews live as Twitterbot first: metadata wiring is comprehensive (every entity/insights/moment/profile/share surface emits summary_large_image + an /api/og/* image; /api/og, /share, /moment, /profile, /insights all crawler-public in proxy.ts) — but one real defect class found and fixed (commits `3152e7d` + `96cc8ee`, deploy `dpl_37EepRPsHbaG7YtQEMz8xUYb6gPE` READY):

- **OG 500 class (FIXED):** entity OG cards (team/set/player/series/edition montages) + moment/profile OG routes passed raw upstream image URLs to Satori, which fetches them itself with no per-image error isolation — one dead/slow/oversized upstream 500'd the whole card, so the shared link rendered with NO preview. Live repro: `/api/og/team?slug=portland-trail-blazers` (all 4 montage thumbs on ipfs.dapperlabs.com). New [lib/og/img-data.ts](lib/og/img-data.ts) pre-fetches every card image to a data URI (4.5s timeout; IPFS gateways rewritten to the edge-cached `/api/public/ipfs-media/<cid>` proxy; WebP/AVIF dropped — resvg can't decode them; **4MB/image + 10MB/card caps** — measured live: satori renders a 2.85MB 2880px PNG but dies on a 7.67MB one) so Satori does zero network I/O and failures degrade per-image (placeholder/fewer tiles), never per-card. Verified live post-deploy: blazers + los-angeles-lakers team cards, edition/set/player/moment/profile/share/insights OGs all 200 image/png. **Revert:** `git revert 96cc8ee 3152e7d`.
- **Trophy Case PDF export (NEW):** `GET /api/profile/trophy-case/pdf?username=<u>` renders the public 6-slot trophy case as a branded landscape-Letter PDF (pdf-lib; dark theme, tier-colored slab borders, player/set/serial/tier/FMV/collection per slab, case-total FMV footer, rippackscity.com CTA). Same anon SECDEF RPC as `/api/profile/trophy-slabs` — exports exactly what /profile/<u> already shows publicly. Per-image 6s timeout + PNG/JPEG magic-byte sniff (pdf-lib can't embed WebP → placeholder tile). GET/HEAD-only proxy.ts carve-out; "EXPORT PDF ↓" button next to the 🏆 TROPHY CASE header on /profile/<u>. Verified live: 200 application/pdf, valid EOF, 5 images embedded, layout visually checked. New dep `pdf-lib@^1.17.1` (pure JS). **v2 (`f5e96e4`, same day, Trevor-directed):** NO FMV/valuation anywhere on the card; webp/avif thumbnail URLs rewritten to format=jpeg (Dapper media APIs parameterize format — this is why an AllDay slab was a placeholder in v1) + width bumped to 440; gold special-serial chips (1 OF 1 / #1 MINT / PERFECT MINT / JERSEY MATCH via `editions.jersey_number`) + edition-badge line (Rookie Mint etc) per slab. Verified 6/6 images embed. **v3 (`6dfdac4`):** badge + special-serial ICONS (real badgesV3 SVG art via /api/badge-image, RPC-brand glyphs for the 4 dead-upstream TS badges, satori-rasterized) instead of pills; moment art background-stripped (jpeg-js/pngjs flood-fill white/black → transparent, content-crop) so it floats on the slab panel and fills the tile. **Found: the TS leg of /api/badge-image is upstream-DEAD site-wide (momentTags path 404s) — queued in the ledger with a ready lever.** **v4 (`fc0168a`):** collection-correct badge art (AllDay designs only on AllDay slabs; TS uses RPC glyphs — no cross-collection art), badges merged from `get_edition_badges_unified` (site-canonical; verified Lillard Cosmic 8:145 truly badge-less in the catalog), art tiles 116→148pt, RPC logo replaces the top-right wordmark. **v5 (`3a684e0`):** found the LIVE TS badge-art upstream (`assets.nbatopshot.com/static/momentTags/static/<camelSlug>.svg` — what the TS moment page itself renders); `/api/badge-image` topshot leg repointed there, fixing on-site TS badge icons SITE-WIDE, and the PDF now uses the real TS art per collection. DATA: Lillard Cosmic 8:145 verified carrying "Top Shot Debut" on the live TS moment page but missing from badge_editions (sweep structural miss) — seeded via `audit_20260707_seed_badge_editions_8145_topshot_debut`; BADGE-SWEEP-COVERAGE-GAP queued in the ledger. **Revert:** `git revert 3a684e0 fc0168a 6dfdac4 f5e96e4 3152e7d`.

### July 7, 2026 (Cowork, interactive) — Moment/edition-page offer correctness: subedition-aware offers end-to-end (sweep keying + indexer + 2,355-offer re-key + display fns), Floor stat removed, sales history gains parallel attribution

Trevor flagged mixed-up offers on Moment pages. Root causes found + fixed end-to-end (commit `431138b`, deploy `dpl_f9jCB9J7GLF3uFaddHfAYNxPXnwU` READY; 5 fn migrations + 1 worktable; verified live on `/nba-top-shot/edition/233:8121::19`):

- **GQL offers-sweep was BLENDING parallels.** `searchMarketplaceEditions` returns one row per printing, but the sweep collapsed them onto the base pair (max offer / min ask across Standard+Hexwave+Jukebox+…). Now requests `parallelID` and keys parallel rows to their own `::subID` edition via a (play_id_onchain, subedition_id)->external_id map (6 ambiguous pairs skipped; set.flowId is a 0-sentinel on sub rows so the pair key mirrors the circulation-backfill approach). Per-printing `edition_offers` rows (incl. **per-printing low_ask** — fills the "per-printing floor not yet indexed" gap) accrue as the sweep re-walks the catalog (~4 ticks/cycle). NOTE: first post-deploy tick validates the GQL field; if it ever 422'd, the sweep logs fetchError and writes nothing (no bad data path). Sweep tick pending the cron-job.org dropout recovery.
- **On-chain indexer DROPPED subeditionId.** `topshot-offers-indexer` parsed TopShotSubedition offers but keyed them to the base pair, discarding the subedition id (stale "no 3-part rows exist" comment predating Stage B). Forward-fixed: keys to `setId:playId::subId` with base fallback. **Historical re-key:** recovered subeditionId for all 2,379 open subedition offers whose base has cataloged parallels by decoding each offer's own OfferAvailable tx event via Flow REST (sandbox, 100% recovery), re-keyed **2,355** onto their `::` edition. Audit/revert map: `audit_20260707_offer_sub_backfill` (offer_id, old_edition_id, new_edition_id; revert = `UPDATE offers o SET edition_id = a.old_edition_id FROM audit_20260707_offer_sub_backfill a WHERE o.offer_id=a.offer_id AND a.applied_at IS NOT NULL`).
- **Display fns (all SECDEF, security invariants clean, `check_secdef_anon_execute_violations()` []):** `get_edition_high_offer` re-signed with `offer_scope` ('parallel'|'edition') — on `::` pages best offer = GREATEST(own printing's GQL row + own on-chain subedition offers, base edition-grain on-chain offer fillable by any printing); per-printing low_ask; base pages unchanged (DROP+CREATE, anon NOT granted, postgres/authenticated/service_role re-granted). `get_moment_best_offer` gains parallel/base-edition legs (grain 'parallel'). `get_edition_offers` on `::` pages now lists own subedition/serial offers PLUS base edition-grain offers. Verified: Hexwave 233:8121::19 shows $21 sub offer > $18 edition offer (scope 'parallel'); 219:7408::18 shows its $1,500 sub offer; base 8:133 unchanged $5,500.
- **Sales history parallel attribution:** `get_edition_recent_sales` (4-arg) + `get_moment_detail` recent_sales rows gain `parallel` (per-NFT via `topshot_moment_subeditions` + subedition-name map, fallback to the edition's own printing; TS only, NULL elsewhere -> column hidden). UI: Parallel column in `SalesTablePaginated` + the /moment/[id] Recent-activity table. Measured base-keyed sales are 99.9% genuinely Standard (14d), so the column is attribution clarity + honest surfacing of in-flight conflation rows.
- **Floor stat removed** from both the edition page and /moment/[id] (redundant with Recent Sales; the FMV-strip prose still cites the recent-sale low when no ask exists).
- **Fn reverts:** recreate prior definitions from migration history (`audit_20260707_get_edition_high_offer_subedition_scope`, `_high_offer_chain_subedition_leg`, `_get_moment_best_offer_subedition_aware`, `_get_edition_offers_subedition_aware`, `_edition_recent_sales_parallel_attribution`, `_get_moment_detail_recent_sales_parallel`); code revert `git revert 431138b`.


### July 10, 2026 (overnight pass) — OFF-HOURS / MONITOR-MODE (~20:41 PDT Jul 9, no skew); shipped 0 (correct); post-ship watch of the recent concierge ships ALL PASS; 2 new LOW findings queued

Fired ~20:41 PDT (outside the 00:00-06:00 window → monitor-mode: full triage + post-ship watch, queued instead of shipped, docs-only). NO clock skew (shell 03:41Z ≈ DB now() 03:41:40Z ≈ newest sale 03:32Z / fmv 03:40Z). Push available, no FREEZE. origin/main `187669ed` at clone, advanced +1 docs commit `8c2f48d0` (daytime Cowork ledger log) ~2 min later (rebased before output). Shipped **0** (off-hours), reverted 0, repaired 0, closed 0. Drained 3 inbox files. Handoff: [docs/handoff-2026-07-10-overnight-pass.md](docs/handoff-2026-07-10-overnight-pass.md).

- **Post-ship watch — recent concierge ships PASS, 0 reverts.** `187669ed` (per-tool timeout budget — wallet tools 20s vs the blanket 6s that raced them out under DB contention) + `eeff0b1a` (check_wallet reports the FULL portfolio via the wmc `/share` snapshot; wallet-search 400s unknown collection slugs instead of silently falling through to the TS on-chain walk) both prod-READY (`dpl_GPgKyi2YLm6ZMKyEUEYc1Q5nWJb8`). `get_runtime_errors(/api/support-chat, 40h)` NONE; Sentry 0 unresolved/24h; support-chat not in `pipeline_fails_24h`. No regression on the concierge path.
- **NEW queued (2, both LOW).** (1) **TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS** — `topshot-moments-hydrator` 31 fails/24h from upstream `Error with GetMintedMoment` GQL errors on a subset of moment nft_ids; alternates ok=true (resolves 100/tick when clean) / ok=false (window dominated by erroring moments resolves 0). `stubs_created:0` / `edition_resolution_failures:0` / `graphql_failures:0` → NO corruption, NOT stalled (`detect_stalled` []), NO writer leak (sentinel 0). Moment→edition enrichment only; NOT auto-shipped (moment-resolution/ingest path is off-limits; self-limiting). WATCH: if it degrades to persistent 0-resolution, a stuck head-of-queue of permanently-unresolvable moments wants a CC de-prioritize/quarantine. (2) **FMV-CLAMP-DISCONNECTED-ASK-CONTENTION-TIMEOUT** — daily backstop cron jobid 34 (`rpc-fmv-clamp-disconnected-ask`, 13:55Z) timed out its 07-09 tick under contention; the INLINE clamp on every fmv-recalc (P1b) covers the fn ⇒ no user gap; retries 07-10 13:55Z (folds into DAYTIME-CONTENTION).
- **Health GREEN.** security **0/0/0/0**; `stalled_pipelines` **[]** (the 07-08 03:08Z PINNACLE-RECONCILE-CRON-DROP self-healed; pinnacle_ask 0.1h); trust 16 metrics, 1 BREACH `topshot_impossible_parallel_serials` **4/3** = known self-healing `::`-cataloging class (4 stragglers cataloged 06-20/21 whose floor-seed circ < a real sale serial: `118:4134::8` circ 1 vs #9, `223:7518::20`, `224:7680::21`, `224:7684::21`; per-parallel circ backfill reconciles them, was 3→1 on 07-06); sentinel TS-UUID-48h **0**; editions TS **19,088** (+937 = ongoing 07-07/08 `::` subedition cataloging wave, sentinel 0 confirms no hyphen-UUID leak) / AllDay 6,190 / Golazos 575 / UFC 518; FMV TS H+M **5,173** (improving from 4,948) / AllDay 809 / UFC 15 / Golazos 4; DB **8,869 MB** (+502 benign); `check_pgcron_recent_failures()` 1 (the fmv-clamp above); Sentry 0 unresolved/24h; Vercel prod `187669ed` READY, no ERROR-state deploy.
- **Carried:** cron-job.org dropout family (operator, recurring, self-heals — recovered from both the 07-07 and 07-08 instances), ULTIMATE-FMV-RECALC-V1-MISSED-TICK, SALES-SERIAL-BACKFILL-WATCHLIST, CROSS-SOURCE-DEDUP, BADGE-CATALOG-STALE-429, DAYTIME-CONTENTION family, DAILY-PORTFOLIO-SNAPSHOT-GATEWAY-TIMEOUT, CLASSIFY-ACQ-ALLDAY, FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP, REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT, BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, VERCEL cost family, and the standing owned/operator/gated queue. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### July 7, 2026 (overnight pass) — GENUINE OVERNIGHT (01:03 PDT, no skew); shipped 0 (correct); TOP FINDING = cron-job.org broad trigger dropout (~35 pipelines silent since ~06:43Z, operator/self-healing); post-ship watch of the heavy 07-06 wave ALL PASS; CLOSED 1 (pack-EV historical backfill jobid 43 self-resolved)

Fired in-window (shell 08:02:50Z ≈ DB `now()` 08:03:14Z — NO skew; the newest-sale 06:43Z / fmv 06:48Z lag is a SYMPTOM of the cron dropout below, not skew). Push available, no FREEZE, origin/main `5c45977e` unchanged start→end. Shipped **0** (correct — sole HIGH self-resolved, dominant finding is external/operator, rest is post-ship-watch/track-only), reverted 0, repaired 0, **closed 1**. Drained 4 inbox files. Handoff: [docs/handoff-2026-07-07-overnight-pass.md](docs/handoff-2026-07-07-overnight-pass.md).

- **TOP FINDING (operator) — CRONJOB-ORG-TRIGGER-DROPOUT-20260707.** `detect_stalled_pipelines()` = 14 + a `pipeline_runs` sweep shows **~35 cron-job.org-triggered pipelines frozen at ~06:34–06:50Z** (still down ~90 min at 08:10Z), incl. core ingest: topshot-sales-indexer (06:43Z → `sales.max(ingested_at)` 06:43Z), wmc-fmv-populate/fmv-recalc/snapshot-pack-asks (06:48Z), wallet-backfill* (06:46Z), offers-sweep, alerts-dispatch, topshot-buyer-backfill. GHA/Vercel/pg_cron pipelines run normally through 08:0xZ (compute-topshot-pack-ev 08:07Z, pinnacle-nft-resolver 08:06Z) and the stopped pipelines log **NO failures** → external trigger not firing, not our auth/route/deploy (Vercel prod READY; sandbox curl 503 = Cloudflare bot-block, not a real outage). Same known recurring class as Q3 (05-31, self-recovered ~7.9h), CRON-DROP-WAVE (06-09), LISTCACHE-CRON-DROP (06-08). **Cursor-based ⇒ no data loss; self-heals on cron-job.org recovery.** NOT auto-actionable (external secret-bearing console = off-limits). **Operator:** check cron-job.org execution history from ~06:40Z + re-enable/re-fire any auto-disabled entries (FMV Recalc Force Stale, sales-indexer, snapshot-pack-asks first).
- **CLOSED — PACK-EV-HISTORICAL-BACKFILL-CRON-120s-TIMEOUT (jobid 43, the 03:08Z monitor HIGH).** Self-resolved: `check_pgcron_recent_failures()` [] (green 05:13→06:03Z per the 06:06Z monitor, re-confirmed). Revert if ever: `DROP FUNCTION backfill_topshot_historical_pack_ev(int); SELECT cron.unschedule('rpc-backfill-historical-pack-ev');`.
- **Post-ship watch — 07-06 daytime CC/Trevor wave: ALL PASS, 0 reverts.** Pinnacle pack-EV pipeline (compute-pinnacle-pack-ev, pg_cron 17 */6) both scheduled ticks green (00:17Z + 06:17Z), `total_sealed` generated-col early-bug stays gone. Golazos pack-EV 1 benign pool-timeout 06:37Z (brand-new low-pri pipeline). AllDay/TS pack-EV healthy (carried DBSAT `targets` statement-timeout contention class only). Security **0/0/0/0** after ALL 07-06 migrations (pack-EV secondary-ask reframe + survivor-bias + varied-pool guards, Golazos/Pinnacle pack-EV, Dune ownership `topshot_ownership`+`get_edition_top_owners`, special-serial-owners→AllDay); fmv_sanity 0; pinnacle_fmv_impossible 0. Sentry: only NEXTJS-1T OG pipe-abort (1 event/4h, no growth, benign).
- **Health GREEN** apart from the dropout: security 0/0/0/0; trust **16/16 ok, breaches []** (impossible_parallel 1/3, unmapped 30/100, edition_integrity 4/50, pinnacle_fmv_stale 22/30); sentinel TS-UUID-48h **0**; editions FLAT (TS 18,151 / AllDay 6,190 / Golazos 575 / UFC 518); FMV TS H+M **4,948** (improving from 4,934) / AllDay 820 / UFC 15 / Golazos 4; DB **8,367 MB** (+162 benign); Vercel prod `5c45977e` READY (intermediate ERROR `f6cd1ef0` superseded). **Re-opened LOW:** ULTIMATE-FMV-RECALC-V1 missed the 07-07 06:35Z tick (likely cron-dropout casualty; operator; self-healed last time). **Carried:** SALES-SERIAL-BACKFILL-WATCHLIST (gate frozen by dropout), CROSS-SOURCE-DEDUP, BADGE-CATALOG-STALE-429, DAYTIME-CONTENTION family, + standing owned/operator/gated queue. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### July 6, 2026 (overnight pass, RUN 2) — GENUINE OVERNIGHT (01:03 PDT, no clock skew); shipped 0 (correct); post-ship watch of the 07-05 evening P1–P8 CC wave ALL PASS; CLOSED 1 (ultimate-fmv self-healed); queued 1 new (cross-source-dedup, not-a-safe-ship) + 1 future (serial-backfill watchlist)

The real scheduled 01:02-PDT overnight run, ~8h after the earlier off-hours `run-3983f38a` (00:08Z, 16h-stale sandbox). NO clock skew this run (shell 08:02:41Z ≈ DB now() 08:03:15Z ≈ newest sale 08:03:05Z, within ~35s). Push available, no FREEZE, origin/main `c2918b66` unchanged start→end (not advancing). Shipped **0** (correct), reverted 0, repaired 0, **closed 1**. Drained 1 inbox file. A quiet honest green night whose value was the independent post-ship watch of the P1–P8 wave the earlier run didn't cover, plus closing 1 self-healed item. Handoff: [docs/handoff-2026-07-06-overnight-pass-2.md](docs/handoff-2026-07-06-overnight-pass-2.md).

- **Post-ship watch — 07-05 EVENING P1–P8 CC wave: ALL PASS, 0 reverts.** Prod advanced `c09f9693`→**`12bf57ce` (dpl_5Zs53) READY**. **P3** `get_pack_detail_bundle` (SECDEF/30s/secured): every `[pack-detail] …statement timeout` runtime-error group is attributed to the SUPERSEDED `dpl_6mMQJbzU` (last 02:49Z) — **ZERO on current prod** → the 10-way-fan-out→1-bundle-RPC + Suspense-stream change is quieting the class (watch 48h). **P4** Pinnacle render-keyed serial-premium FMV: fns present + SECDEF + secured, new table RLS-on, mint≥25 UI guard (`12bf57c`) live, 0 new Sentry/error class. **P6a** Pinnacle moment-page chrome: only benign DEP0169. **P7a** `sales-serial-backfill` now writes pipeline_runs (06:40Z ok=true resolved:2). **Env-fix `c09f9693`** verified — `drain-conflated-subeditions` 20:30Z 07-05 ok=true split 2283 wmc (the prior run's open P8 item). Security **0/0/0/0** after all wave migrations.
- **Health GREEN.** security **0/0/0/0**; trust **16/16 ok, breaches []** (impossible_parallel 1/3, unmapped 30/100, edition_integrity 4/50, pinnacle_fmv_stale 22/30, fmv_sanity 0); `stalled_pipelines []`; `check_pgcron_recent_failures() []`; sentinel TS-UUID-48h **0**; FMV TS H+M **4,934** (improving) / AllDay 825 / UFC 15 / Golazos 4; editions TS **18,151** (+7 ::subID) / AllDay 6,190 / Golazos 575 / UFC 518 (AllDay −1 / Golazos −6 = 07-05 ghost deletions, benign); DB **8,205 MB** (+46 benign); Sentry **0 unresolved/24h**; Vercel prod `12bf57ce` READY, no ERROR deploy, **no new runtime-error class** (all 47 groups known families). Conflation guard `topshot_conflated_editions` **623** = in-flight subedition de-conflation working set (drains daily 20:30Z), NOT trust-breaching → deferred to daytime CC.
- **CLOSED — ULTIMATE-FMV-RECALC-V1-MISSED-TICK (self-healed).** 07-06 06:35:22Z daily tick **ok=true** 2552ms; clean cadence resumed (the 07-05 miss was a one-off overnight non-fire). No operator action.
- **NEW queued (2):** **CROSS-SOURCE-DEDUP-STATEMENT-TIMEOUT** (nc1; jobid 32 `40 * * * *` flaps 120s in the 21:00–00:00Z contention window, recovered overnight; **not shipped** — the monitor's `sold_at`-window fix is NOT result-identical for the backfill-fed `sales` table + it's the `sales` DELETE path → CC/operator; folds into DAYTIME-CONTENTION); **SALES-SERIAL-BACKFILL-WATCHLIST** (future-night, gate unmet — only 1 logged tick since P7a; bank 2 clean ticks then add the watchlist row). **Carried (sharpened):** BADGE-CATALOG-STALE-429 (nc2; badge-sync GHA scheduled `45 2,8,14,20`+`15 */6` but no successful catalog run since 07-02, last attempt 07-04 429; operator inspect Actions history). **Carried standing:** DAYTIME-CONTENTION-CLUSTERS-BROADENING, CLASSIFY-ACQ (nc5, latest ok), FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP, + the standing owned/operator/gated queue. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### July 6, 2026 (overnight pass) — OFF-HOURS/late (~17:08 PDT; sandbox VM+DB view started ~16h STALE); MONITOR-MODE, shipped 0 (correct); post-ship watch of the heavy 07-05 daytime subedition wave ALL DB-CLEAN; CLOSED 1 (impossible-parallel breach self-resolved), carried 2 LOW

The nightly pass fired against a sandbox whose VM clock + initial Supabase connection were frozen ~16h stale at 2026-07-05 08:03Z (shell 08:02Z == stale-DB now() 08:03Z == stale app rows — the clock-skew guard passed falsely, all three sharing the frozen source). Ground truth via independent clocks: origin/main had advanced **24 commits** past the clone HEAD `1c7e148f` (full 07-05 daytime CC subedition session), Vercel prod is `c09f9693` (~22:08Z 07-05), and a live DB re-read returned `now()=2026-07-06 00:08Z` (fresh sales 00:07Z; editions 18,144 matching the 21:13Z monitor). Real time ≈ 00:08Z 07-06 (~17:08 PDT) = OFF-HOURS + origin actively advancing → two independent queue-only conditions → **shipped 0** (correct). Push available, no FREEZE. Full handoff: [docs/handoff-2026-07-06-overnight-pass.md](docs/handoff-2026-07-06-overnight-pass.md).

- **Post-ship watch — 07-05 daytime CC subedition wave (verified LIVE 00:08Z 07-06): ALL DB-CLEAN, 0 reverts.** Wave = Population A remap + Population B base-parallel probe + collision-knot orchestrator (`1bc4732`) + AllDay serial on-chain rewrite v17 (8,964/9,675 recovered) + special-serial owner resolver (`ef80868c`) + serial=0→NULL sentinel + VGN-263 de-conflate/base-circ reconcile + Golazos mojibake + drain-orchestrator env-var fix (`c09f9693`/`a2b26c8f`). Live: security **0/0/0/0**; sentinel TS hyphen-UUID leak 48h **0** (the +654/2d TS editions → **18,144** are 100% `::subID`, not a leak); trust **16/16 ok**; `edition_integrity_flags` 4/50; phantom serial-0 **0**; Sentry **0/24h**; Vercel prod `c09f9693` READY, no new error class; DB 8,159 MB (+342 = ts_history_backfill + Population-B probe queue, benign).
- **CLOSED — TOPSHOT-IMPOSSIBLE-PARALLEL-SERIALS-BREACH** (the 21:13Z monitor's cand 1): self-resolved (`topshot_impossible_parallel_serials` 3→1, under threshold). Old sales remapped onto freshly-cataloged `::` parallels whose floor-seed circ briefly sat below the serial; the per-parallel circ backfill raised it. No action.
- **Carried (2 LOW):** ULTIMATE-FMV-RECALC-V1-MISSED-TICK (clean daily 06-28→07-04 06:35Z, missed the 07-05 tick; ~41.5h silent; Ultimate-tier FMV only; WATCH 07-06 06:35Z self-heal; RPC_ADMIN_TOKEN cron = operator if it misses again); BADGE-CATALOG-STALE-429 (last run 07-04 21:38Z ok=false 429, none since; LOW/cosmetic; GHA/operator). Reconciled-as-already-handled (no action): a "prod-behind-main/BLOCKED-deploys" alarm (MOOT — prod is `c09f9693`; BLOCKED = superseded-concurrent), the allday-pack-opens cursor_stalled false-positive (already silenced `a6e401e4`), and the stale-view conflation-guard climb (the `c09f9693`/`a2b26c8f` env-var fix + Population A/B sweep converge it). See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### July 4, 2026 (overnight pass) — GENUINE OVERNIGHT (01:02 PDT, no clock skew); shipped 0 (correct); post-ship watch on the heavy 07-03/04 daytime CC/QA + perf wave ALL PASS; CLOSED 2 (serial-fmv weekly timeout already fixed 06-30 + fmv-populate missed-tick self-healed); queued 1 (allday-pack-opens stuck backfill)

Fired in-window (08:02Z / 01:02 PDT; shell ≈ DB `now()` 08:02:35Z ≈ app-stamped sales 08:01Z / fmv 07:58Z — NO skew). Push available, no FREEZE. Sandbox clone `$HOME/rpcwork`; origin/main `8cf55abc` unchanged start→end. Shipped **0** production changes (correct — every candidate is resolved / self-healed / ingest-adjacent-queue / contention-watch), reverted 0, repaired 0, **closed 2**. Drained 3 inbox files. A quiet honest night whose value was the independent post-ship watch + closing 2 items that were already resolved but still being carried. Full handoff: [docs/handoff-2026-07-04-overnight-pass.md](docs/handoff-2026-07-04-overnight-pass.md).

- **CLOSED — SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (was night-count 4).** Already resolved by CC migration `20260630235957 audit_20260630_serial_fmv_fits_statement_timeout_600s`: all three weekly serial-FMV fit fns now carry `statement_timeout=600s` in proconfig (`compute_serial_fmv_power_model`, `compute_serial_fmv_multipliers`, and the new `compute_serial_fmv_jersey_model` jobid 30). All three weekly jobs (cron jobids 5/6/30, `0/5 11 * * 0`) are **pure pg_cron** `SELECT public.compute_…()` — in-DB, no HTTP route / after()-lambda kill trap, so the 600s raise is the correct + complete fix (unlike the special-serial-MV HTTP-route case). jobid 6 last failed 06-28 at exactly 120.04s (the item's origin); next fire 2026-07-05 11:00Z validates. Verified in-run via `pg_proc.proconfig`. The prior 4 nights carried it as "unverifiable-in-run," but the fix has been live since 06-30 and the proconfig is verifiable regardless of the Sunday cron. Revert if ever: `ALTER FUNCTION … RESET statement_timeout` on the three fns.
- **CLOSED — TOPSHOT-FMV-POPULATE-MISSED-TICK (was night-count 1).** Self-healed: the single missed 01:38Z Jul-4 tick (overnight-contention non-fire) recovered next tick — 07:38Z ok=true (11.1s, sets_mapped 243), perfect 6h cadence resumed. Supplementary GQL-catalog FMV populate; TS FMV fresh throughout (topshot_fmv_stale ≤0.4h). No action.
- **QUEUED (new) — ALLDAY-PACK-OPENS-BACKFILL-404 (LOW; night-count 1; CC/operator — ingest edge fn + cron).** `allday-pack-opens-backfill` is STUCK, not just flapping: every tick since ~03:52Z (25 fails/24h) re-attempts the identical event range `137378483-137378732` → 404, never advancing. Root: edge fn `supabase/functions/ingest-allday-pack-opens/index.ts` `mode=backfill` walks the cursor down toward `DEFAULT_FLOOR=30000000`; cursor `event_cursor.id='allday_pack_opens_backfill'`=137408483, and the next window [137378483,137408482] straddles the current access-node spork floor ~137390146 (focus.md `SPORK_FLOOR_HINT`) — the sub-chunk below the floor is a pruned previous spork ⇒ permanent 404; the scan marks fatal and the cursor never advances. LOW (historical pack-opens enrichment; the FORWARD path `allday-pack-opens-forward` is healthy @156925690; not user-facing/FMV; the 144 failed runs/day are pruned daily; `detect_stalled_pipelines()` doesn't flag it). NOT auto-shipped: correct fixes touch the ingest edge fn or the cron console (both off-limits/operator); no clean DB-only park exists (cursor≤FLOOR falsely marks `done` AND skips the still-reachable [137390146,cursor] window). **Ready fix (a) no-deploy/operator:** set the cron `allday-pack-opens-backfill` entry to pass `?floor=137390146` (the override is already supported) → next tick captures [137390146,137408482], advances the cursor, then logs `done:true` and no-ops. **Ready fix (b) durable/CC:** raise `DEFAULT_FLOOR` 30000000→~137390146 + `deploy_edge_function`. Parking loses nothing recoverable (sub-spork-floor opens are unreachable via public Flow REST anyway — that's what the 404 IS).
- **Post-ship watch — ALL PASS, 0 reverts** over the heavy 07-03→07-04 daytime CC/Trevor QA + perf wave (`fdf35b65`→`7fb01a60`, prod `7fb01a60`/`dpl_GbCmDYo` READY): **def899f1** `mv_pack_ev_latest` 1705 == `pack_ev_latest` 1705 + `mv_topshot_set_play_catalog` 9182 (the pack/market/team DBSAT-timeout classes are not climbing daytime on current prod — residual is the 06:0xZ overnight-contention window only); **eb44ac04** pinnacle-nft-resolver (126 ok/11 fail/12h, last_fail 01:16Z) + wmc-fmv-populate (673 ok/12 fail/12h, last_fail 01:13Z) both clean ~7h since the 01:1xZ window, latest ok; **7fb01a60** LISTED collection_id scope prod READY, no new error class; **topshot-sales-history-backfill 429-fix** draining (pending 5684→5571, gql_errors ~96→2/tick, maxed_out 0); the **def899f1 residuals** (`[api/packs] calibrated merge` + ipfs-media 25s/504) last-seen ONLY on the superseded `dpl_Gvtsnni6` 00:16–00:51Z, NOT climbing on current prod. Security 0/0/0/0 after all wave migrations.
- **Health GREEN.** security **0/0/0/0**; trust **16/16 ok** (breaches []; the 06:06Z `offer_edition_gap $70` breach self-cleared to 0 — OFFER-SANITY self-clearing transient); `detect_stalled_pipelines()` [] (fmv-populate self-healed); `check_pgcron_recent_failures()` []; `get_pipeline_alerts()` 2 INFO (golazos+ufc resolving_editions, benign); sentinel TS-UUID-48h **0**; editions FLAT (TS 17,490 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS H+M **4,785** (improving from 4,756) / AllDay 857 / UFC 15 / Golazos 4; fmv_sanity 0; unmapped 30/100; DB **7,817 MB** (+393 = ts_history_backfill_v1-dominated drain, decelerating, benign — corrects the 07-03 note that named allday_studio_history_v1); Sentry **0 unresolved/24h**; Vercel prod `7fb01a60` READY 0 ERROR; 15 artifacts, none broken/repaired. **Carried queued:** CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (nc 4), FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP (DB-growth-contention watch), operator P8 residual, + the standing owned/operator/gated queue. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### July 3, 2026 (overnight pass) — GENUINE OVERNIGHT (01:02 PDT, no clock skew); shipped 0 (correct — inbox empty, no SHIP-eligible candidate); post-ship watch on the heavy 07-02 daytime CC wave (P1b FMV clamp / P3 UFC media / P7 offer_fill guard / P8 moments guard) ALL PASS; queued 1 LOW transient

Fired in-window (08:02Z / 01:02 PDT; shell ≈ DB `now()` 08:02:30Z ≈ app-stamped sales 07:56Z / fmv 07:58Z — NO skew). Push available, no FREEZE. Sandbox clone `$HOME/rpcwork`; origin/main `5f0c00b5` unchanged start→end. Shipped **0** (correct — inbox EMPTY since 07-02 daytime was interactive CC P1-P8 not monitor ticks; every queued item is off-limits/owned/operator/gated/CC/FMV-adjacent; the sole new health signal is a single-tick transient), reverted 0, repaired 0, closed 0. Value = the independent post-ship watch + health verification. Full handoff: [docs/handoff-2026-07-03-overnight-pass.md](docs/handoff-2026-07-03-overnight-pass.md).

- **Post-ship watch — ALL PASS, 0 reverts** over the 07-02 daytime CC wave (`00fc4ee4`→`5f0c00b5`, prod `1cd46de` READY): **P1b** FMV disconnected-ASK clamp born-inline every fmv-recalc (Step-10 clamp_rows 2–87/run all ok, no 23h lag), display guard fresh (1,382 / 452 exceeds_max / 0 disconnected), backstop cron jobid 34 first-fires 07-03 13:55Z (expected); residual detector 35 but worst genuine escape `171:6497` $0.85 vs $0.45 target = sub-$1 floor commons + rounding artifacts — **egregious $42/$170/$2924 disconnected-FMV class GONE**, TS H+M 4,756 (HIGH/MED untouched), fmv_sanity 0. **P3** UFC ipfs-media proxy — 0 new runtime-error class. **P7** offer_fill guard — 4,515/7d flowing fresh 07:28Z, not blocking legit inserts, editions FLAT. **P8** `replace_topshot_moments_batch` guard HOLDING — newest impossible-parallel moment 18:42Z (pre-guard 21:13Z), **0 new in ~13h since**; total 464→169 via the operator `topshot-p8-moment-drain` 23:37Z (174 re-keyed, the designed guard-then-drain workflow); 169 residual = operator finite-drain follow-up. Security **0/0/0/0** after all wave migrations.
- **Health GREEN.** security 0/0/0/0; trust **16/16 ok** (breaches []; +`topshot_impossible_parallel_serials` 1/3 from P7/P8); `detect_stalled_pipelines()` [] / `get_pipeline_alerts()` 1 INFO (ufc_sales benign) / `check_pgcron_recent_failures()` 2 transient; sentinel TS-UUID-48h **0**; editions FLAT (TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS H+M **4,756** / AllDay 863 (benign re-bucket) / UFC 15 / Golazos 5; fmv_sanity 0; unmapped 29/100; DB **7,424 MB** (+212 = allday_studio_history_v1 still filling, benign/watch-tail); Vercel prod `1cd46de` READY, 0 ERROR; 11 pipeline-fail pipelines all latest-run ok=true (transient). Artifacts 15, none broken/repaired.
- **NEW queued (1) — OVERNIGHT-0623Z-CONTENTION-CLUSTER (LOW; WATCH).** `rpc-remap-misattributed-sales` + `rpc-allday-ev-corrected-refresh` each timed out ONLY the 07-03 06:23Z tick (123s/120.5s) then recover 12:23Z; every other tick/32h ok (remap 36–83s, allday-ev 5–19s) — overnight-backfill I/O contention (same window as pack-detail/edition pool timeouts), not a growing-table cliff yet. remap durations creeping (36→123s) so if it fails multiple ticks it graduates to the classify-acq class. A single-transient statement_timeout bump is premature/unverifiable-in-run. **Carried unchanged:** CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (night-count 3, still flapping — do NOT close), SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (nc 4, resurfaces 07-05), operator P8 finite-drain residual (169), + the standing owned/operator/gated queue (REFRESH-SPECIAL-SERIAL-OWNERS-MV, BUYERBF, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron, VERCEL cost, PIN waves, DUPE1, Q2/Q5/Q6, N1, IPFS ×2, P4/P5). See [docs/overnight/ledger.md](docs/overnight/ledger.md).

---

### Older sessions

Archived to `docs/sessions/` (newest-first within each file):

- `docs/sessions/2026-07.md` — July 2 → July 1 (overnight passes; post-ship watches on the 06-30/07-01 daytime waves).
- `docs/sessions/2026-06.md` — June 30 → June 1 (overnight passes + daytime CC; parallel-conflation program, pack-EV, FMV hardening, Candy/Solana onboarding).
- `docs/sessions/2026-05.md` — May 31 → May 2 (entity pages, ops/QA pass, FMV recovery, V1 Dapper indexer, multi-collection enrichment).
- `docs/sessions/2026-04.md` — April 26 / 21 / 10.

**Doc archive layout:** shipped dated handoffs/audits live under `docs/archive/handoffs/` + `docs/archive/audits/`; weekly health snapshots (`PROJECT_HEALTH_*.md`) under `docs/health/`. Links inside `docs/archive/**`, `docs/health/**`, `docs/sessions/**` are frozen history — don't rewrite them.

---

## Infrastructure IDs (required on every tool call)

- Supabase project ID: `bxcqstmqfzmuolpuynti` (PRO Micro, $25/mo, upgraded May 3 2026)
- Vercel project ID: `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`
- Vercel team ID: `team_YWGCVToPBJSS60NgVh8jiCFV`
- GitHub repo ID: `1188272071`

Both Vercel IDs are required on every single Vercel API or MCP tool call — never omit teamId.

---

## Route structure

Feature pages live at `app/(collections)/[collection]/`. The layout at that level provides header, nav, and ticker — pages must NOT include standalone headers.

The `[collection]` dynamic segment serves all 5 published collections: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike. Common tabs across collections: `overview`, `collection`, `sniper`. Top Shot additionally has `packs`, `pack-sniper`, `sets`, `market`. Pinnacle does not have `sets`. Top Shot also has Fast Break and RTR (Road to the Ring) game features. There is NO standalone `badges` tab — the page type lingers in `lib/collections.ts` but no collection lists it and `/[collection]/badges` 307-redirects to `/overview` (badges render inline on edition/moment pages via `get_edition_badges_unified`).

Other top-level surfaces:
- `/share/[wallet]` — shareable collection card with OG image
- `/profile/[username]` — public profile, served from `/api/public/profile/[username]`
- `/analytics` and `/analytics/wallets/[address]` — analytics dashboards
- `/admin/*` — internal tools incl. `/admin/flowty-analytics` (RPC_ADMIN_TOKEN gated)

Selected API endpoints worth knowing about:
- `/api/edition-stats`, `/api/pack-roi`, `/api/collection-snapshot`, `/api/overview-stats`
- `/api/admin/prune-pipeline-runs` (POST, Bearer `$INGEST_SECRET_TOKEN`; daily cron)
- `/api/wallet-backfill[-allday|-pinnacle|-golazos|-ufc|-multicollection]` — fire-and-forget Cadence walks; `?force=true` to bypass `skip_cached`
- `/api/seed-wallet-refresh` — every 6h orchestrator

Collection registry: `lib/collections.ts` (8 collections defined; 5 currently published).
Old flat routes redirect to the new nested paths.

---

## Frequently used commands

```bash
# Development
npm run dev

# TypeScript health check (use before deploying when Vercel rate-limited)
npx tsc --noEmit

# Tests (see "Testing & CI coverage" for details)
npm test                 # vitest run — route + lib unit/integration suites
npm run test:coverage    # same suites + coverage ratchet (what CI gates on)
npm run test:cadence     # extract inline Cadence + `flow cadence lint` the fixtures

# Git — always use Git Bash (MINGW64) on Windows
git status
git add -A && git commit -m "feat: ..."
git push origin main

# Vercel redeploy via REST (use PowerShell Invoke-WebRequest — curl fails silently in Git Bash)
# POST https://api.vercel.com/v13/deployments
# body: {"name":"rip-packs-city","gitSource":{"type":"github","repoId":"1188272071","ref":"main"}}

# Env var writes also require PowerShell Invoke-WebRequest
# POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId}

# Wallet backfill ad-hoc (force full re-walk)
# curl -X POST 'https://www.rippackscity.com/api/wallet-backfill?force=true' \
#   -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
#   -d '{"wallet":"0x..."}'
```

---

## Key files to always reference

- `lib/collections.ts` — collection registry
- `lib/cart/CartContext.tsx` — cart state (addToCart: thumbnailUrl must be `null` not `undefined`)
- `lib/wallet-backfill-helpers.ts` — generic + paginated runners (`runIdOnlyBackfill`, `runAllDayDetailsBackfill`, `runPinnacleDetailsBackfill`, `runPaginatedDetailsBackfill`)
- `lib/cadence/` — per-collection Cadence scripts (pinnacle-wallet, allday-wallet, etc.)
- `app/api/sniper-feed/route.ts` — merges Top Shot GQL + Flowty listings
- `app/api/fmv/route.ts` — FMV lookup endpoint
- `app/api/support-chat/route.ts` — AI concierge (5 tools, Claude Sonnet)
- `proxy.ts` — site lockdown (Next.js 16 convention, replaces middleware.ts; hardened May 8)
- `workers/topshot-proxy/` — Cloudflare Worker. Routes: POST / or POST /topshot → public-api.nbatopshot.com/graphql, POST /allday → public-api.nflallday.com/graphql, POST /allday-consumer → nflallday.com/consumer/graphql.
- `workers/odds-proxy/`, `workers/rpc-sports-proxy/`, `workers/hybrid-custody-proxy/`, etc. — see "Worker auth surfaces (3 rotation domains)" above. `hybrid-custody-proxy` uses `INGEST_SECRET_TOKEN` Bearer; the others use `TS_PROXY_SECRET` via `X-Proxy-Secret`; `spork-proxy` uses `SPORK_PROXY_SECRET`. Don't conflate them.
- CI/CD: GitHub Actions workflows in `.github/workflows/` — rpc-pipeline.yml, ops-monitor.yml, pipeline-sentinel.yml, allday-ingest.yml, badge-sync.yml, pinnacle-owner-discovery.yml, topshot-active-listings-ingest.yml, topshot-listing-cache.yml, smoke-tests.yml, plus the backstops (sales-indexers, wallet-backfill, snapshot-institutional-wallets, offer-fill, topshot-sales-history-backfill, allow-list-reconcile) and ci.yml. NOTE: there is NO `alert-checker.yml` — pipeline-failure alerting runs via `/api/check-alerts` (`get_pipeline_alerts()` → Telegram+email), triggered by cron-job.org, not a workflow.

### Cloudflare Workers (current full list)

All `.tdillonbond.workers.dev`. Three independent auth surfaces — see "Worker auth surfaces (3 rotation domains)" above for the split.

| Worker | Purpose |
|---|---|
| `topshot-proxy` | TopShot GraphQL + AllDay GraphQL (public-api + consumer) |
| `pinnacle-proxy` | Pinnacle GraphQL |
| `spork-proxy` | Flow mainnet historical spork access (port 8070) |
| `allday-proxy` | AllDay-specific GQL routes (sibling to topshot-proxy /allday) |
| `rpc-sports-proxy` | NBA stats / DK projections / cdn.nba.com |
| `odds-proxy` | the-odds-api.com pass-through with apiKey injection |
| `reddit-proxy` | Reddit API access |
| `hybrid-custody-proxy` | HybridCustody event reads against `0xd8a7e05a7ac670c0` |

---

## Supabase schema facts (critical — verify before writing queries)

**Volatile facts (table existence, FMV home per collection, enum values, RLS-on count) are generated from the live DB into [docs/reference/schema-truth.md](docs/reference/schema-truth.md) — that file wins on any disagreement with the prose below.** It is regenerated by the weekly `rpc-data-quality-sweep` (drift → ledger Queued). The conventions below (the two collection vocabularies, partitioning, UUIDs) are stable; the per-table/enum/count specifics can drift, so confirm against schema-truth.md (or re-query) before relying on them.

### Two collection-string conventions (CRITICAL footgun)

The DB uses **two distinct vocabularies** for identifying collections, and they are not interchangeable. Mixing them up will fail INSERTs against CHECK constraints.

| Vocabulary | Used by | Values |
|---|---|---|
| **Long-form** | `sales`, `editions`, `collections.slug` | `nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike` |
| **Short-form** | `flowty_transactions`, `flowty_loans`, `flowty_loan_events` | `topshot`, `allday`, `golazos`, `pinnacle`, `ufc`, `unknown` / `other` |

`flowty_transactions` has CHECK constraint `flowty_transactions_collection_check` whitelisting short-form only. Writing `'ufc_strike'` to a flowty_* table fails at INSERT. `lib/flowty-tx-classifier.ts` MUST emit `'ufc'` not `'ufc_strike'`.

The bridge between the two is `analytics_sales` view, which translates long → short via CASE.

### Collection UUIDs

- TopShot: `95f28a17-224a-4025-96ad-adf8a4c63bfd`
- AllDay: `dee28451-5d62-409e-a1ad-a83f763ac070`
- Golazos: `06248cc4-b85f-47cd-af67-1855d14acd75`
- UFC: `9b4824a8-736d-4a96-b450-8dcc0c46b023`
- Pinnacle: `7dd9dd11-e8b6-45c4-ac99-71331f959714`

### editions table (29 columns — verified against information_schema.columns)

Columns: id (uuid), external_id (varchar), collection_id (uuid), player_id (uuid), set_id (uuid), name (varchar), tier (enum), series (smallint), edition_kind (enum), circulation_count (int), badges (text[]), reward_indicators (text[]), thumbnail_url (text), video_url (text), play_type (varchar), play_category (varchar), game_date (date), home_team (varchar), away_team (varchar), first_minted_at (timestamptz), last_updated_at (timestamptz), created_at (timestamptz), updated_at (timestamptz), set_id_onchain (int), play_id_onchain (int), collection (text), player_name (text), set_name (text), team_name (text).

The denormalised `player_name` / `set_name` / `tier` / `team_name` / `circulation_count` columns DO exist on this table — safe to select directly.

Pinnacle editions live in parallel table `pinnacle_editions` with different schema: id (text), external_id (text), edition_key (text), character_name, franchise, set_name, variant_type, edition_type, mint_count, is_chaser, thumbnail_url, ask_price, ask_source, plus 10+ Pinnacle-native columns (studio, materials, effects, size, color, thickness). `edition_key` format: `royalty_code || ':' || variant_type || ':' || printing`.

### wallet_moments_cache (wmc)

UNIQUE constraint: `(wallet_address, collection_id, moment_id)` — the cross-collection-safe shape (replaced the old `(wallet_address, moment_id)` on May 6). Columns include `edition_key`, `serial_number`, `tier`, `set_name`, `player_name`, `character_name`, `mint_count`, all populated by JOIN-to-editions backfill RPCs.

### Account linking (May 8)

- `linked_accounts(parent_addr text, child_addr text)` — PK on the pair. 6 active links currently.
- RPCs: `get_linked_parents(child_addr)`, `get_linked_children(parent_addr)`, `get_linked_all(addr)`, `resolve_canonical_owner(addr)`.
- View: `analytics_sales_resolved` — re-projects `analytics_sales` through canonical-owner resolution to deduplicate parent + child wallets in leaderboards.
- Ingest pipeline: `hybrid_custody_events` cron every 20min via cron-job.org.

### fmv_snapshots table

Columns: edition_id, fmv_usd, confidence, computed_at. NO source column.
`confidence` is enum `fmv_confidence` UPPERCASE: `HIGH`, `MEDIUM`, `LOW`, `NO_DATA`, `ASK_ONLY`, `SALES_ONLY`, `STALE`. Never use `.eq("confidence", "high")` — always uppercase, and never use `.ilike` on enum columns (use `.eq` per `f55e022 + e9c90e5` fix).

**Two confidence vocabularies (footgun):** `fmv_snapshots.confidence` accepts `HIGH | MEDIUM | LOW`, but `nba_player_projections.confidence` is gated by a different CHECK that allows only `HIGH | MED | LOW` (3-letter MED).

`fmv_snapshots` is partitioned. `CREATE INDEX CONCURRENTLY` must be standalone `execute_sql`, NOT inside `apply_migration` (which wraps in transaction). FMV write pattern: delete-then-insert NEVER upsert; `collection_id NOT NULL`. Daily duplicates are intentional history, not a bug.

Most recent FMV per edition:
```sql
SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC
```

### sales table

Year-partitioned: `sales_2020` through `sales_2026`. Dedup on `transaction_hash` (unique index in sales_2026).

### badge_editions table

Has: player_name, badge_type, series_number. Use `.or()` with ilike for case-insensitive player name matching. Always `.trim()` player names.

### flowty_transactions table

- `flowty_transactions.failure_category` is unconstrained TEXT; valid values are the `FailureCategory` union in `lib/flowty-tx-classifier.ts`. Order matters in `RULES` array — first match wins, so put more specific patterns above broader ones (e.g. INSUFFICIENT_GAS_FUNDS before INSUFFICIENT_BALANCE).
- Flow Error Code 1118 is a payer-gas error (pre-execution), distinct from in-execution Cadence errors. Categorized as `INSUFFICIENT_GAS_FUNDS`.

### General rules

- `apply_migration` for DDL; `execute_sql` for reads/verification.
- Always query `information_schema.columns` before writing route handlers to confirm exact column names.
- RLS check: `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false`. Currently 0 rows — RLS on every public table (245 as of 2026-06-30; the invariant is "0 rows", not the count — see [schema-truth.md](docs/reference/schema-truth.md)).
- `health_check()` RPC function is the single source of truth for platform state.
- `pipeline_runs` uses `pipeline` text column (not `function_name`) and `ok` boolean (not `status` text); `extra` is JSONB — use `extra->>'key'` for text extraction.
- Supabase MCP multi-statement queries return only last result — use single statements per call.
- PostgREST caps reads at 1000 rows and CLAMPS explicit `.limit()` above that — paginate with `.range()` or use an RPC for larger reads.
- `players` + `sets`: composite `UNIQUE(external_id, collection_id)`.
- `execute_sql(query text) RETURNS void`, SECDEF, service_role only.
- `tier_type` enum (full live set): `ULTIMATE / LEGENDARY / RARE / UNCOMMON / FANDOM / COMMON / CHAMPION / CHALLENGER / CONTENDER`. Top Shot uses `COMMON / FANDOM / RARE / LEGENDARY / ULTIMATE`; UFC Strike uses `CHALLENGER / CONTENDER / FANDOM`. (`UNCOMMON` / `CHAMPION` exist in the enum too — see [schema-truth.md](docs/reference/schema-truth.md).)

### Security posture (May 3 audit)

0 security ERRORs. SECDEF anon-revoke complete — 10 previously anon-callable fns now `postgres + service_role` only (incl. `query_sql`, `save_user_wallet`, `upsert_wallet_moments`, `pinnacle_upsert_nft_map`, `activate_pro_from_payment`, `classify_acquisition`). RLS on every public table (0 with `rowsecurity=false`). 17 SECDEF views dropped.

---

## API contracts

### Top Shot GraphQL

Endpoint: `https://public-api.nbatopshot.com/graphql`. Cloudflare blocks Vercel + Supabase egress, so all server-side calls must go through `topshot-proxy`. `marketplace/graphql` is also Cloudflare-blocked server-side — do not use.

- UUID editions: `searchEditions` via `topshot-proxy` (`bySetIDs` / `byPlayIDs`).
- Integer editions (`setID:playID`): Cadence `TopShot.getPlayMetaData(playID:UInt32)` + `getSetSeries(setID:UInt32)`.
- `topshotScore { points }` does NOT exist — causes 422. Use `tssPoints` as null placeholder.
- `listingOrderID` is the preferred field (shipped April 2026); fall back to `storefrontListingID`.

### NFL All Day GraphQL (two endpoints, non-overlapping schemas)

Cloudflare WAF on **both** hostnames blocks Vercel + Supabase egress, so both go through the topshot-proxy worker — but on different routes because the schemas don't overlap.

- `https://public-api.nflallday.com/graphql` — wallet/marketplace queries (`searchMomentNFTsV2`, `searchMarketplaceEditions`). Worker route `/allday`.
- `https://nflallday.com/consumer/graphql` — only endpoint that hosts `getMintedMoment(momentId)` and related per-moment lookups. Worker route `/allday-consumer` (added 2026-05-05). Same `X-Proxy-Secret`.
- Vercel routes that hit consumer/graphql directly (`lib/alldayGraphql.ts`, allday-wallet-search, allday-sets) work because Vercel egress isn't WAF-blocked there. Edge functions and other non-Vercel egress need the worker.

### Flowty API

POST `https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot`.
Required headers: `Origin: https://www.flowty.io`. `blockTimestamp` is in milliseconds. `valuations.blended.usdValue = LiveToken FMV equivalent`. 4 pages = 96 listings max. `buyUrl = https://www.flowty.io/listing/{listingResourceID}`.

All listing-cache routes use `flowty-proxy` Supabase edge function (Flowty blocks Vercel IPs). `cached_listings` upsert-then-conditional-purge, threshold = function-top `startedAt`. TS `onConflict: "flow_id"`. Flowty wins dedup on `flowId`.

### Flowty Pinnacle FMV floor issue (open)

Flowty Pinnacle emits uniform $1 floor across 10k+ listings (`upstream_floor_only=true`) — NOT a parser bug, real marketplace behavior. `cached_listings` ASK unreliable for Pinnacle until direct integration.

### Flow REST API scripts

Each argument must be `btoa(JSON.stringify({type, value}))` — NOT raw object. Response: `atob(raw.trim().replace(/^"|"$/g, ""))` → `JSON.parse`. `access(all)` required (not `pub`). Use `Buffer.from(str, 'utf8').toString('base64')` for Cadence encoding (NOT `btoa()` — breaks on Unicode).

### RPC FMV API

- `GET /api/fmv?edition={setID:playID}[&serial=N]`
- `POST /api/fmv` (batch, up to 100)
- `GET /api/fmv/demo` (public, no auth, 1hr cache, 5 real samples)
- Returns: `fmv, serialMult, badgePremiumPct, adjustedFmv, confidence, updatedAt`

---

## Sniper feed specifics

File: `app/api/sniper-feed/route.ts`

- Merges Top Shot GQL + Flowty listings.
- Parallel TS fetches with 6s `withTimeout()`.
- Dedup by `flowId`; Flowty wins on conflict.
- Sort by `updatedAt desc`, 200 max.
- `SniperDeal` has `source: "topshot" | "flowty"`.
- Flowty FMV fallback to Supabase when LiveToken null/zero.
- Retired moments excluded.
- `tsCount: 0` on every call = Top Shot proxy returning empty/auth-rejected; check worker reachability and `X-Proxy-Secret` ↔ `PROXY_SECRET` alignment.

---

## Flow/Cadence contract addresses

- Dapper merchant: `0xc1e4f4f4c4257510`
- DUC payment: `0xead892083b3e2c6c` (NOT `0x82ec283f88a62e65` — that was an older alias)
- **NFTStorefront V1 (Dapper, native AllDay/Golazos/UFC marketplace): `A.4eb8a10cb9f87357.NFTStorefront`** (no V2 suffix) — primary path discovered 2026-05-18
- NFTStorefrontV2 (Dapper, TopShot PackNFT / Pinnacle / MFL packs only): `A.4eb8a10cb9f87357.NFTStorefrontV2`
- NFTStorefrontV2 (Flowty fork, dormant since 2026-05-14): `A.3cdbb3d569211ff3.NFTStorefrontV2`
- NonFungibleToken + MetadataViews: `0x1d7e57aa55817448`
- FungibleToken: `0xf233dcee88fe0abe`
- HybridCustody: `0xd8a7e05a7ac670c0`
- DapperOffersV2: `0xb8ea91944fd51c43`
- NFL All Day: `0xe4cf4bdc1751c65d`
- AllDay/Golazos/UFC trade contract (buyer = contract addr): `0xedf9df96c92f4595`
- Disney Pinnacle: `0xedf9df96c92f4595`
- DapperStorageRent: `0xa08e88e23f332538`

### Cadence purchase transaction rules

- Must be Cadence 1.0 syntax: `auth(BorrowValue) &Account` — NOT `AuthAccount`.
- Dual-signer required: Dapper co-signer + buyer.
- DUC leak check in `post{}` block required by Dapper co-signer.

### Per-collection Cadence gotchas

- **TopShot**: `TopShot.QuerySetData` exposes only `setID/name/series` — no `tier` field. Tier must come from GQL or per-NFT MetadataViews.
- **AllDay**: `borrowMomentNFT` DOES exist on `&AllDay.Collection` (concrete type at `/public/AllDayNFTCollection`) — prefer it over the generic `borrowNFT(id)! as! &AllDay.NFT` cast since the typed return directly exposes `editionID / serialNumber / mintingDate`. For V2 Flowty fork sales, `buyer` field on the event payload is the Flowty fee router (`0x3cdbb3d569211ff3`) not the real buyer — recover via `fetchTxBuyers` (proposer/authorizers/payer minus EXCLUDED_ADDRESSES). For V1 Dapper sales, the real buyer comes from `A.e4cf4bdc1751c65d.AllDay.Deposit.to`; do NOT rely on the contract address parenthetical.
- **Pinnacle**: borrow plain `&{NonFungibleToken.Collection}`, call `borrowNFT(id)`, pass NFT ref directly to `MetadataViews.getTraits/getEditions`. `MetadataViews.ResolverCollection` is NOT exposed at the standard MetadataViews address for Pinnacle.
- **UFC**: Import `UFC_NFT` only for `CollectionPublicPath`; borrow as generic `NonFungibleToken.CollectionPublic` + `borrowNFT(id)!` force-unwrap. `Traits` FAILS (AnyStruct `.toString()`). Fighter from edition name split `"|"`. 0% series characteristic.

---

## Cadence Work

The Flow Claude Code Plugin (`onflow/flow-ai-tools`) is installed and provides 11 specialist skills plus a Cadence MCP server.

Before modifying any `.cdc` file, any string literal containing Cadence (notably files in `lib/cadence/` and any inline `cadence` template literal in `app/api` routes), or any FCL `mutate` or `query` call, the Cadence MCP must be used to fetch the source of the relevant deployed contract on Flow mainnet and verify that the functions, fields, structs, and argument types being called actually exist on chain. Do not rely on training-data assumptions about Cadence APIs — they are frequently wrong for Cadence 1.0.

The canonical list of mistakes this verification step is meant to prevent lives in the **Per-collection Cadence gotchas** section above. Do not duplicate those bullets here — refer back to them.

The Cadence MCP is for development-time verification only. All production reads must continue to route through the existing proxy layer (Cloudflare Workers `topshot-proxy`, `spork-proxy`, `allday-proxy`, `pinnacle-proxy`, `hybrid-custody-proxy`, `reddit-proxy`, `rpc-sports-proxy` on `tdillonbond.workers.dev`, plus the `flowty-proxy` Supabase edge function) because Flow public endpoints and the Top Shot and Flowty APIs all block Vercel egress IPs at the edge. Never suggest replacing a worker-proxied route handler with a direct call to `rest-mainnet.onflow.org`, `public-api.nbatopshot.com`, or `api2.flowty.io`.

When onboarding a new collection or building the planned Pinnacle direct integration, fetch the live contract source via the Cadence MCP first and verify struct fields against the actual deployment before writing the script.

---

## Series map (on-chain UInt32 → display name)

- 0 = Series 1 (S1)
- 2 = Series 2 (S2)
- 3 = Summer 2021 (Sum 21)
- 4 = Series 3 (S3)
- 5 = Series 4 (S4)
- 6 = Series 2023-24 (23-24)
- 7 = Series 2024-25 (24-25)
- 8 = Series 2025-26 (25-26)

There is NO series=1 on-chain. Series 0 IS Series 1. There is NO "Beta".

---

## AI Concierge

Claude Sonnet chat on every page via SupportChatConnected component.
Routes: `/api/support-chat` (5 tools), `/api/support-chat/feedback`, `/api/support-chat/context`, `/api/support-report`.
Supabase table: `support_conversations` (with feedback col).
Escalations: Telegram + Resend. Rate limit: 25/hr.
Env vars needed: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_EMAIL`.
Telegram sentinel bot: `@rpc_sentinel_bot`, chat_id `1755958876`.

### Concierge non-negotiable rules

1. **Pinnacle FMV**: NEVER join by `edition_key` alone — always triple (`character_name`, `set_name`, `variant_type`) per `92aab30`. Cadence uses `Int` not `UInt64`.
2. Memory-FMV banned (`a910745`) — must tool-call same turn.
3. `get_fmv` reads `editions + fmv_snapshots` primary; returns `p10/p50/p90` + sample shape.
4. Tier filter: `.eq` not `.ilike` per `f55e022 + e9c90e5`.
5. `trg_support_conv_updated_at` OWNS `shipped_at / updated_at` — never set manually.
6. `/api/admin/feedback` GET MUST filter `feedback_type IS NOT NULL`.

---

## Brand system

- `app/rpc-tokens.css` owns all tokens.
- `var(--rpc-red)` = `#E03A2F`.
- Fonts: `var(--font-display)` = Barlow Condensed, `var(--font-mono)` = Share Tech Mono.
- RULE: never hardcode `#E03A2F` or `'Barlow Condensed'` literals — always use tokens.
- Exception: `ConsoleGreeting.tsx` console `%c` only.

---

## Auth chain

Supabase IMPLICIT flow — magic links return tokens in URL hash fragment (not query). `/auth/confirm` client page parses `window.location.hash` → `setSession`.

Resend SMTP via apex `rippackscity.com` (DKIM/SPF/MX at `send.rippackscity.com`, `From=noreply@rippackscity.com`). Gate at `/api/auth/request-magic-link` calls `check_email_allowed` RPC server-side.

Domain: `www.rippackscity.com` canonical (migrated May 3, commit `d26ceac`); old `rip-packs-city.vercel.app` 308-redirects via 3 Vercel domains.

### proxy.ts site lockdown (May 8 hardened, commit 2e3be0f)

Order:
1. Bearer `INGEST_SECRET_TOKEN` / `CRON_SECRET` (or `?token=` query) — FIRST.
2. Public path bypass — `/login`, `/early-access`, `/auth`, `/api/{auth,early-access,admin,cron,public,wallet-search,support-chat,cart,health}`, `/admin`, static.
3. Else → `getUser` → 60s `rpc_al_check` cookie → `check_email_allowed` RPC.
4. False → `signOut()` + `/login?error=access_revoked`.
5. RPC fail → fail-closed `/login?error=allowlist_unavailable`.

`/` (root) is NOT public. `allow_list.status='active'` is the only valid state. Sign-in at `/login`. Banner links `@tdillonbond`.

---

## Windows / Git Bash patching rules (CRITICAL)

- Dev environment: Windows, Git Bash (MINGW64), VS Code.
- CRLF line endings silently break Node.js string-replace patches — use `findIndex` on split line arrays, or sed line-number targeting.
- Heredocs truncate on long files — use Claude file output tool + PowerShell `cp` or `Set-Content -Encoding UTF8`.
- Never use heredoc with `${{}}` characters in Git Bash.
- For multiline replacements: write a `.js` patch script that normalizes CRLF→LF before matching.
- `sed` with `1i\` insert syntax works in Git Bash but not PowerShell.
- Multi-line Python in GitHub Actions YAML `run:` steps causes YAML parse errors — use single-line one-liners.
- `curl` fails silently in Git Bash for Vercel REST calls — always use PowerShell `Invoke-WebRequest`.
- **Web/console automation secret-safety:** never broad-query the DOM (`querySelectorAll('input')`, full `read_page`, `get_page_text`) on pages that can hold secrets (admin consoles, cron-job.org job-edit pages, env/secret settings, any auth-header surface). Scope reads to the specific target control; use the find tool for one element; never echo Bearer/token/key/secret values. Secret-bearing config edits are operator-only. (A Cowork session leaked `INGEST_SECRET_TOKEN` by broad-reading a cron-job.org job-edit page — the Advanced-tab Authorization header is in the DOM even when that tab isn't open.)

---

## Vercel tool behavior

- MCP tools are READ-ONLY for env vars.
- All env var writes: `POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId}` via PowerShell.
- `get_runtime_logs` truncates at ~50 chars — use short time windows (1-2h), low limits (20-50), unfiltered.
- `environment: "production"` required on `get_runtime_logs` or it returns nothing.
- `console.warn` is NOT indexed by Vercel log search — always use `console.log` for diagnostics.
- `web_fetch_vercel_url` returns cached results; `tsCount: 0` in body = reliable proxy failure signal.
- `web_fetch_vercel_url` only supports GET; preview URLs have SSO protection.
- `get_deployment_build_logs` needs `limit: 200` to get past npm warnings to actual TypeScript errors.
- Redeployment after env var changes: `POST https://api.vercel.com/v13/deployments` with gitSource ref. Dashboard "Redeploy" reuses cache, doesn't re-bake env vars.
- `list_deployments` (with `since` timestamp in ms) → get deployment ID → poll `get_deployment` until READY (~30-38s).
- Free tier: 100 deploys/day limit; rate limiting resolves after ~24h. (RPC is on Pro now.)
- **Pro Lambda `maxDuration` hard cap is 800s.** Anything higher silently sends the deploy to ERROR state — including docs-only deploys — and the build log shows "Compiled successfully" + Sentry sourcemap upload with no logged error text before transition. Commit 32de87a set `wallet-backfill-multicollection` to 900 thinking it was the ceiling; the next 5 deploys all failed invisibly until `b32102e` reverted to 800. Same flavor of invisible failure as the fmv-recalc silent stall — both class of bug looks healthy from every external signal.

---

## Testing & CI coverage (added 2026-07-12)

The repo has a real automated test suite. Run it before shipping non-trivial code changes.

- **Runner:** [vitest](vitest.config.ts) (`npm test` = `vitest run`; `npm run test:watch`; `npm run test:coverage`). Setup file `vitest.setup.ts`; `@` alias resolves to repo root.
- **Two measured layers (coverage `include`: `lib/**/*.ts` + `app/api/**/route.ts`):**
  - **Route handlers** — every `app/api/**/route.ts` is imported and its auth/param guards are exercised; a large subset also drive the 2xx success/accept path by stubbing the `after()` / Supabase seam. The deepest inline bodies (live TopShot/AllDay GraphQL fan-outs, Flow REST/Cadence scans, SSE streams) can't be cleanly driven, so **a line % in the 30s here is EXPECTED**, not a happy-path guarantee.
  - **Pure `lib/**` logic** — unit tests for decode/FMV/pack-EV/market-adapter/logger modules.
- **React components** have a separate jsdom harness (`__tests__/*.test.tsx`, ~44 component files; ~565 test files total under `__tests__/`). They are measured **separately** — deliberately NOT folded into the route/lib coverage number (400+ presentational files would swamp the signal).
- **Deno edge functions are excluded** (no Deno toolchain in CI). Their pure logic is extracted into vitest-importable modules under `supabase/functions/_shared` (`cdc.ts`, `hybrid-custody-parse.ts`, `pack-ev-edition.ts`, `spork-cursor.ts`) and tested there. When editing an edge fn, put testable logic in `_shared` and import it.
- **CI ratchet (do not defeat).** `vitest.config.ts` `thresholds` sit just below the live baseline (2026-07-12: stmts 33 / branch 25 / funcs 38 / lines 35 vs actual 34.3 / 26.5 / 39.4 / 36.5), so a coverage **drop** fails CI while normal noise passes. **Raise these as coverage climbs; NEVER lower them to make a red build pass.** CI job is `unit-tests` in [.github/workflows/ci.yml](.github/workflows/ci.yml), which runs `npm run test:coverage`.
- **Cadence tests** — `npm run test:cadence` extracts inline Cadence (`scripts/extract-cadence.mjs`) and runs `flow cadence lint` against `tests/cadence/fixtures/`. Gated in CI (`cadence-lint` job, needs `flow dependencies install`). See `docs/cadence-testing.md`.

---

## Code patterns and conventions

- Full file replacements only — never snippets or diffs.
- Claude Code prompts: plain text, no markdown code blocks (optimized for iPhone copy-paste).
- `proxy.ts` is the correct Next.js 16 convention (renamed from middleware.ts).
- Supabase client must be typed as `any` to avoid TypeScript errors in API routes.
- `generateMetadata` cannot be exported from client components (`"use client"`) — belongs in server-component `layout.tsx`.
- `useSearchParams` requires a Suspense wrapper — any page using it must be wrapped.
- Branch fragmentation is a recurring issue — consolidate with cherry-pick onto one canonical branch before merging.
- Fire-and-forget >30s: `import { after } from 'next/server'`, `after(runX())`, return `{status: accepted}`.
- `project_knowledge_search` is NOT authoritative against live repo — Claude Code's direct file inspection wins every disagreement; prompts should allow Claude Code to correct false premises.

---

## Hot wallet & secrets

- Flow CLI hot wallet: `0x3aa11c84d776838f` (Key 0, ECDSA_secp256k1, SHA2_256). NOT account-linked. `flow.json` gitignored. NEVER use a HybridCustody / linked wallet as the hot wallet.
- Cadence service payer wallet: `0x73f55c4450b8d466` — the account designated as `payer` (gas) for backend-submitted Cadence transactions; distinct from the hot wallet above (Flow allows a separate proposer/authorizer vs. payer). Monitored every 30min by `/api/cron/cadence-payer-balance-check`, which alerts below 0.05 FLOW. If it runs dry, every Cadence transaction fails pre-execution with `INSUFFICIENT_GAS_FUNDS` (Flow error 1118).
- Key env vars: `INGEST_SECRET_TOKEN`, `CRON_SECRET`, `FLOWTY_PROXY_TOKEN`, `TS_PROXY_SECRET`, `RPC_ADMIN_TOKEN`, `SPORTS_PROXY_URL`, `SPORTS_PROXY_SECRET`, `ANTHROPIC_API_KEY`.

---

## Cron / scheduler surfaces (4 independent schedulers)

Scheduled work spans **four** schedulers, not one — verified live 2026-07-06, all green (`detect_stalled_pipelines()` = `[]`, `check_pgcron_recent_failures()` = `[]`):

- **cron-job.org** — ~33 HTTP-triggered pipelines, `*/20` cadence dominant (sales-indexer→AllDay-unmapped-resolver chain, HybridCustody events, ingest). The external console is operator-only; cron entries aren't enumerable from the repo.
- **GitHub Actions** — 16 workflows (`.github/workflows/`), 15 scheduled (rpc-pipeline, ops-monitor, pipeline-sentinel, allday-ingest, badge-sync, pinnacle-owner-discovery, topshot-active-listings-ingest, topshot-listing-cache, smoke-tests, the *-backstop jobs, …; ci.yml is the one non-scheduled). No `alert-checker.yml` exists — health-alert dispatch is cron-job.org → `/api/check-alerts` + `/api/sentinel`.
- **Vercel crons** — 21 entries in [vercel.json](vercel.json) (`maxDuration` ≤ 800; pack-grail-MV refresh, rip-metadata backfill, misattribution drain, `/api/cron/warm` business-hours warmer, ownership-sync-dune, …).
- **pg_cron** — 34 active jobs in `cron.job` (in-DB refreshes/backfills: conflated-editions remap, thin-FMV guard, special-serial-owners MV, serial-FMV weekly fits, rookie ownership MVs, …). `check_pgcron_recent_failures()` is the authoritative pg_cron health check (reads `cron.job_run_details`, which `detect_stalled_pipelines()` can't see).

`/api/admin/prune-pipeline-runs` (daily) keeps `pipeline_runs` ~9.5K rows. Notable recurring jobs:

- Sales-indexer chained → AllDay-unmapped-resolver (every 20min, NOT its own cron entry).
- HybridCustody events — every 20min.
- Seed-wallet-refresh — every 6h.
- Sync-nba-odds — every 60min during 22:00 UTC → 06:00 UTC.
- ownership-sync-dune (Vercel) — Dune TopShot ownership index; **weekly** re-execution to stay inside the free Dune credit tier.

---

## Deferred hardening

Tracked but intentionally unfixed — revisit when adding a real consumer or a per-row write API.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each have an INSERT policy with `qual=true`/`with_check=true` for `roles=public`. Hardening to add when revisited: per-row size caps via CHECK constraints, `created_at`-based rate-limit column or trigger, `bot_score` column populated from BotID, possibly an unauthenticated rate-limiter at the edge.
- `user_achievements` + `watchlist_items` migrated 2026-04-27 to service-role-only writes. Both still use `owner_key` (text) instead of user_id UUID. Neither table is referenced by any /api route today. When a real consumer arrives, do the user_id+RLS migration like saved_wallets / trophy_moments / profile_bio.
- `badge_editions.low_ask` coverage gap: AllDay 0/1572 (always NULL), Golazos 12/218 (~5.5%). TopShot healthy at 2578/2987 (~86%). To populate: add a cron that walks `cached_listings` for those collection_ids and upserts `min(ask_price) → badge_editions.low_ask`.

---

## Known issues / active work

Main branch is the canonical clean branch.

**Status reconciled 2026-05-23** against the codebase + production DB. Full verification table: `docs/health/PROJECT_HEALTH_2026-05-22.md` §9. Item numbers below are stable (they match the report); resolved items are listed at the end under their original numbers.

### Platform changes (May 2026) — these make several sections of this file stale

- **Flowty shut down its NFT marketplace FRONTEND (~2026-05-13) — but its API is ALIVE (re-verified 2026-07-07: api2.flowty.io serves current Series-8 listings; the infra now backs dapper.market).** The loan-book (`flowty_loans` / `flowty_loan_events`) ingest and analytics MVs are frozen history, but the `flowty-proxy` edge fn + listing-cache routes are LIVE ingest feeding cached_listings/ASK-FMV today — do not treat them as dead. The "Flowty API", sniper-feed, and worker sections of this file describe what is now legacy/dead infrastructure pending a deliberate teardown. `flowty_loan_events` going cold on 2026-05-11 is expected behaviour, not a regression.
- **NFL All Day ended primary pack sales.** AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only; AllDay is a secondary-market collection going forward.

### Open

0. **Wallet verification (2026-06-07).** "Sign in with Dapper" requires Dapper developer access (request pending, Trevor) — FCL discovery is standard (Flow Wallet/Blocto), which don't custody Top Shot accounts; the FCL button stays for self-custody users only. The working path for TS collectors is the **listing challenge (on-demand check)**: RPC picks one of the wallet's cheap Moments, the user lists it at a unique ~100×/$10-floor price, and `/api/profile/verify-challenge/check` confirms it live via the topshot-proxy GQL then calls `resolve_wallet_challenge_match` (+500 credits). `admin_verify_wallet` (owner-attested) is the interim manual fallback. The old `resolve_wallet_verification_challenges` cron matcher is dead (frozen `cached_listings`) but left in place harmlessly.

1. **Cart execution — SHELVED (2026-05-24, intelligence-first decision).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence code in `lib/cadence/purchase-moment.ts` stays in the repo, dormant and revivable, but off the critical path — do NOT pursue H1/H2 or the external deps (`NEXT_PUBLIC_WALLETCONNECT_ID`, Dapper co-signer registration). Market/Sniper were reframed 2026-05-23 (commit `b19d8f2`) to FMV + discount intelligence with outbound "View Listing" links. `docs/audits/purchase-moment-2026-05.md` retains the historical Cadence detail.

3. **Trade Hub — SHELVED (2026-06-01), same class as Cart #1.** On-chain trade escrow (`RPCTradeEscrow`) is not deployed; the 5 submitters in [lib/trade-escrow/fcl-submit.ts](lib/trade-escrow/fcl-submit.ts) were returning fake `0xstub_` tx ids, implying swaps that never happened. Guarded 2026-06-01: each submitter calls `ensureLive()` (throws unless `RPC_TRADE_ESCROW_ADDRESS` is set); the live routes `/api/trade-chain/{propose,execute,deposit-callback}` + `/api/admin/reclaim-expired-trades` return 503 "Trade Hub is not available yet."; `/dashboard/trade-hub` `notFound()`s via a server gate (split into `TradeHubClient.tsx`). The wishlist/offers/matches CRUD (`/api/trade-hub/*`) is untouched. To re-enable: deploy the contract, set `RPC_TRADE_ESCROW_ADDRESS`, and replace each stub body with the real `fcl.send` per the file's NEXT_STEPS + `RPCTradeEscrow_DEPLOYMENT.md`. Revert the guard: `git revert`.

4. **Pinnacle FMV — RESOLVED (verified 2026-05-24; table renamed 2026-06-08, re-verified 2026-06-28).** The "0 FMV editions" claim was stale. Pinnacle FMV is RENDER-keyed and lives in its own `pinnacle_fmv_history` table (cols: `render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at`; ~13.4k history rows, ~1.8k renders priced in 2d), recomputed daily by engine `pinnacle-2.0.0-render` and propagated to `wmc` hourly by `populate-pinnacle-wmc-fmv`. Pinnacle ASK comes from `pinnacle-listings-indexer` (direct-chain), not Flowty. CRITICAL: Pinnacle FMV lives in `pinnacle_fmv_history`, NOT the uuid-keyed `fmv_snapshots`; the old `pinnacle_fmv_snapshots` table was DROPPED 2026-06-08 (survives only as `pinnacle_fmv_snapshots_backup_20260608`) so a query against `pinnacle_fmv_snapshots` now 42P01-errors.

7. **AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25.** The earlier "historical spork scan" framing was wrong: the backlog is not spork-era data. All 2,550 NFL All Day unmapped rows are under 6 weeks old and were starved by the resolver running at `batch_size: 5` against a Flowty-only lookup. Fixed by the GQL-primary edge-function rewrite + `batch_size 5→200` bump in the 2026-05-25 (latest) session above. The Pinnacle side is separately covered by the direct ASK pipeline (Phase 2C, 2026-05-11). The `spork-proxy` worker remains live for any genuinely spork-era investigation but no longer blocks the unmapped-sales backlog.

9. **Storefront audit pipeline — RETIRED (verified 2026-05-24).** It is a manual script (`scripts/scan-historical-storefront.mjs`), not a deployed cron or route — not monitored, not read by any frontend code. Cold since 2026-04-28 simply because nobody runs the script. De facto retired; no operational action. `storefront_audit_wallets` (5,365 rows, tiny) is harmless — optional drop candidate.

   **Storefront-cleanup machinery removed (2026-06-03).** The manual listing-cleanup chore (`scripts/cleanup-storefront-wallets.mjs` → root `cleanup.cdc`, which shelled `flow transactions send cleanup.cdc <addr> --signer my-account` gas-paid by the Cadence payer wallet `0x73f55c4450b8d466`) was the sole FLOW drain on that wallet, and it cleaned only dead storefronts (tied to the TS listings-indexer retired 2026-05-26 + Flowty shut 2026-05-13) — zero product value, since no live surface (FMV / analytics / insights / concierge / pack-EV — all reads + Supabase) draws on it. Both files were deleted to make the drain impossible to restart from the repo. **The payer wallet `0x73f55c4450b8d466` is intentionally empty and its `cadence-payer-balance-check` cron is paused** while all Cadence-write features (breaks / Cart / Trade Hub) are shelved (the `breaks` schema `20260509120000_breaks_schema.sql` is UNAPPLIED in prod). The `/api/cron/cadence-payer-balance-check` route is left dormant (not deleted) for easy revival. **To revive:** fund the wallet >0.05 FLOW + un-pause the cron-job.org entry. If `cleanup`/`flow` txns keep appearing on Flowscan from this wallet with no human at the keyboard, an out-of-repo scheduler (OS cron / Task Scheduler / launchd) is still alive — kill it as part of the Flowty teardown. Ledger cross-ref: N3.

10. **`/dashboard` token migration** — `app/dashboard/page.tsx` ~1,750 lines. Big lift, defer until stable.

11. **Brand punch list — partial.** Per-feature OG cards exist (`/api/og/{collection,deal,moment,pack,profile,fast-break,default}`). Still missing: the `/home-fmv-preview.png` home screenshot. Fast Break / RTR / admin tokenize once stable.

12. **Blazers trivia** (`lib/blazers-trivia.ts`) — 29 items shelved, still no UI.

14. **Monolith page refactor** — `collection/page.tsx` (~2,900 lines), `sniper/page.tsx` (~2,070), `analytics/page.tsx` (~2,208). Phase 1 plan in `docs/audits/refactor-plan-monolith-pages-2026-05.md`.

15. **`livetoken-portfolio*.json` fixtures — RESOLVED (verified 2026-06-01).** No longer tracked (`git ls-files` returns none for `livetoken-portfolio*` / `nftlocker-*` / `flowty-locker-test.json` / `test-gql.json`); nothing left to `git rm`.

17. **Pack / Moment / Set page tune-up — ongoing.** File:line audit findings live in `docs/archive/audits/PACK_PAGES_AUDIT_2026-05-22.md`, `docs/archive/audits/MOMENT_PAGES_AUDIT_2026-05-22.md`, `docs/archive/audits/SET_PAGES_AUDIT_2026-05-22.md` — those docs are point-in-time and now partially superseded; the current state is here.

   *Shipped* (commits `5c0af8a` → `8d8721e` → `2b7ce7f` → `61f5586`): brand-token consistency is complete across the three page templates, every `components/entity/*` and `components/packs/*` component, and `MomentDetailModal` — the lone exception is the `FmvHistoryChart` recharts `stroke` (SVG presentation attributes can't resolve a CSS var). Also shipped: the Pack AllDay-context banner and the AllDay set-tracker banner; stale-Flowty UI removed (dead "Flowty ask" stat, SEO + ticker copy, `marketplaceLabel` relabelled "Flowty (historical)"); `loading.tsx` skeletons for the moment / edition / set / series routes; and per-collection data-accuracy fixes — Top Shot series-label mapping, UFC tier vocab in `tierColorVar` / `TIER_STRIPE` / `TIER_COLORS`, three-way `is_listed`, honest null handling for Floor / drop_weight / completion-%, FMV-vs-ask labelling.

   *Correction*: the audit docs flag `MomentDetailModal.tsx` / `MomentMedia.tsx` as possible dead code — that is WRONG. A repo-wide grep confirms both are live: `MomentDetailModal` is used by `sniper/page.tsx` and `collection/page.tsx`; `MomentMedia` by `sets/page.tsx`. Their findings are normal fixes, not delete-candidates.

   *Shipped 2026-05-24*: Moment S5 — `MarketplaceStatusBanner` now mounts at the top of `app/(collections)/[collection]/edition/[slug]/page.tsx`. Pack D1 — reward / quest packs (`retail_price_usd = 0`) render a "Reward pack" badge and the value-ratio / EV-margin verdicts are suppressed (no more "Net +$X vs $0 retail" garbage). Pack D3 — the dist-page "Edition EV" column was raw `fmv × drop_weight` (un-normalized); now `fmv × (drop_weight / pool_weight) × slots`, reconciling with the Gross-EV KPI. Pack S2 — the "Buy on Top Shot" CTA is now suppressed when `price_source = "none"` and on reward packs, and re-labelled "Buy primary" / "Buy on secondary market" based on `price_source`. Pack S3 — simulator empty-state copy ("active drops" → "packs with an indexed drop pool"). Pack B6 — `PackTable` tier sort is now rarity-ranked instead of alphabetical (covers UFC tiers too). Pack B5 — `GrailsView` (which uses `useSearchParams`) is now wrapped in a `<Suspense>` boundary. Pack V4 — null-name pull cards / grail chase ribbons got non-empty `alt` text.
   *Remaining* (lower-value tier — most of the audit docs' bullets verified-shipped or punted): modal accessibility (Moment V3 / Set V5 — `role="dialog"`, focus trap; wants browser verification); Set B5 (series rollups derived from only the first 100 editions — needs an aggregate RPC, not a page-layer fix); Set B7 (client-sort partial-page issue — defer until a real consumer complaint); and the longer-tail Set/Moment/Pack V/D items that the audit docs already classify as low severity.

### Resolved (verified 2026-05-23)

- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).** Stalled 2026-05-24 22:03 → 2026-05-25 14:53. Root cause: unchunked `.in("edition_id", …)` in `/api/fmv-recalc` Step 3 + the Step 2a-bis meta fetch blew past PostgREST's URL cap on a ~1,100-edition page; supabase-js surfaced it as a non-throwing `deleteError` and `if (deleteError) return` exited `after()` before `log_pipeline_run` — route crashed silently inside the lambda while `topshot-listing-cache` still logged `fmv_recalc_called: true`. Fix chunked both `.in()` sites at 500 (matching the file's other 3 delete sites) and added `log_pipeline_run` to the fatal-catch + Step 3 error paths so future silent stalls surface in `pipeline_runs`. Cron and chain were never at fault.
- **#2 Sentry error capture** — `NEXT_PUBLIC_SENTRY_DSN` confirmed set in Vercel env + redeployed. SDK wired (org `rip-packs-city`, project `javascript-nextjs`).
- **#3 Flowty event indexer "regression"** — not a bug; Flowty's marketplace shut down (see Platform changes above).
- **#5 AllDay/UFC mis-categorized editions** — only 8 stray editions remain under the TopShot collection_id (all `disney_pinnacle`), not ~454. Effectively resolved.
- **#6 WarmupContext key mismatch** — `WarmupContext.tsx` now prefetches `/api/packs` into the key `PackPageClient` reads.
- **#8 NBA stats / projections** — `nba_player_projections` is syncing again (no longer 0 rows/day).
- **#13 `flowty_archive` growth** — resolved (option-B prune + `VACUUM FULL`; total DB 13.8 → 6.5 GB).
- **#16 `flow test` CI gating** — `.github/workflows/ci.yml` gates `tsc` + the Cadence harness. The `cadence-lint` job's missing `flow dependencies install` step was fixed 2026-05-22; it runs `continue-on-error` (non-blocking) pending a confirmed green run.

---

## Prioritized next actions

**Framing (2026-05-24):** RPC is committed **intelligence-first** — the goal is a product genuinely more useful than nbatopshot.com itself. Cart / live-buy is shelved (see Open #1). **Monetization — the Pro paywall, Stripe, public launch — is tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met.

1. ~~Flowty teardown~~ — **RE-SCOPED 2026-07-07 (verified live): the teardown premise is OBSOLETE.** `api2.flowty.io` is ALIVE and serving CURRENT listings (Series 8 probe 200 OK), and the listing-cache pipelines (`topshot/golazos/allday/ufc-listing-cache`, ~475 runs/wk each, ok=true) actively ingest it and feed cached_listings + ASK FMV + fmv-recalc chaining TODAY. Flowty's trading FRONTEND shut May 2026, but its API infrastructure lives on (now behind dapper.market). Do NOT delete the listing caches, flowty-proxy edge fn, or the ingest chain — they are live production ingest. The 2026-07-07 cleanup removed only the true zero-importer orphans (bot-prerender quote lib, flowty deep-link builder, Firestore offers lib, superseded allday/ufc sniper-feed routes, pinnacle debug route). Remaining candidates (edition-floor's Flowty leg, cart make-offer-flowty) are LIVE-reachable or Cart-gated — touch only with a product decision.
2. Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely differentiated from Top Shot's own site.

*Done — the Market/Sniper reframe to outbound "View Listing" links shipped 2026-05-23 (commit `b19d8f2`); the AllDay `unmapped_sales` resolver was rewritten + un-starved 2026-05-25; see Recent sessions.*

---

## Architecture notes

- FMV recalc v1.5.0 live (WAP + days_since_sale + sales_count_30d).
- TopShot sets catalog: the GQL editions-catalog creates `sets` rows keyed by the TopShot UUID (`external_id`) but does NOT populate `set_id_onchain`. `ensure_topshot_edition_stub` self-heals this on the set-lookup miss path — it bridges UUID→`set_id_onchain` via a sibling edition and backfills the `sets` row (migration `audit_20260523_ensure_topshot_edition_stub_self_heal`). New TopShot sets resolve with no manual seeding.
- Pack EV pipeline v11: queue-poisoning bug fixed — `topshot_pack_ev_targets` view filters zero-priced reward distributions; sentinel rows write to `pack_ev_history` on `pool_empty` with non-NULL `pack_ev` (0 works; view has `BETWEEN -10000 AND 1000000` filter). 0% pipeline failure rate across 23 active pipelines.
- WMC backfill (May 7): TS 99.8% tier / 100% set / 89.6% mint via `UPDATE FROM editions JOIN`. 18 RPCs read `wmc.tier` directly — backfill approach preferred over per-RPC patches. **AllDay mint counts are NOT a coverage gap (corrected 2026-06-05): `editions.circulation_count` is populated for 6190/6191 AllDay editions; the old "AllDay has no circulation" note was stale — it was just a missed wmc denorm. Backfilled `wmc.mint_count` platform-wide (AllDay now 324,510/324,590) and folded `mint_count = COALESCE(wmc.mint_count, e.circulation_count)` into `backfill_wmc_metadata_from_editions` (migration `audit_20260605_backfill_wmc_metadata_add_mint_count`) so the warm/refresh path keeps it current.**
- WMC image denorm (2026-06-05): `wmc.image_url` was never populated — `/share` + `get_wallet_collection_snapshot` rendered placeholder tiles. New SECDEF fn `populate_wmc_image(collection_id, force, limit)` denormalizes `editions.thumbnail_url` (TS/AllDay/Golazos/UFC) + `pinnacle_editions.thumbnail_url WHERE LIKE 'http%'` (Pinnacle), http-only, NULL-only by default. Wired into the `wmc-fmv-populate` cron loop (50k/collection/tick) backed by partial index `idx_wmc_image_url_null`. Pinnacle images are mostly a dead-end (no per-edition on-chain art — see [docs/handoff-2026-06-04-pinnacle-image-catalog-backfill.md]); the fn fills only the ~82 legacy-http Pinnacle thumbnails.
- Flowty analytics (May 6/7): `/admin/flowty-analytics` with `RPC_ADMIN_TOKEN`. 3 materialized views (`mv_flowty_sales/loans_daily`, `mv_flowty_first_activations`) + 5 RPCs (`flowty_top_{buyers, sellers, net_marketplace, lenders, borrowers}`). `refresh_flowty_analytics()` ~1s. UFC/Golazos at 0 in MV until spork. Pinnacle uses `pinnacle_sales` separately.
- GitHub Actions cron every 20min calling `/api/ingest` with `INGEST_SECRET_TOKEN` sourced from repo secrets.
- Watchlist + FMV Alerts: tables and API routes were applied during earlier sessions; the current concierge tool set does not include watchlist/alert tools, so the user-facing path is partially decommissioned. Verify table/route status before reactivating.
- Collection sharing: `/api/collection-snapshot` + `/share/[wallet]` with OG image generation.
- Unique index on `transaction_hash` in `sales_2026` (prevents duplicate wallet-seed rows).
- Flowty relationship: CEO Mike Levy, CTO Austin Kline — aware of and supportive of RPC.

---

## Beta users (current)

- jamesdillonbond — `0xbd94cade097e50ac` (Trevor)
- RipPacksCity — `0xb5053ef95e702657`
- samwise222 — `0xa3d67b29e104e701`
- Mike Levy — `0x11859edcf2f53edd`

Watch wallets at `priority=3` in `seeded_wallets`:
- roham — `0x01d7e57aa5598e47`
- rybaguy — `0xbe9c633840e40df3`

---

## Pack ingestion & classification (2026-05-18 session)

### `pack_purchases` architecture

- `seller_address = 0x18eb4ee6b3c026d2` is the **NFTStorefrontV2 escrow contract**, NOT a TokenForwarding receiver. Rows with this seller are **secondary peer-to-peer sales**; the actual selling user is identified by `storefront_resource_id` (980+ distinct values observed).
- `seller_address` has a CHECK constraint requiring `NULL` or `^0x[0-9a-f]{16}$` format. **Do NOT overload with sentinel values like `'mint:<contract>'`** — use the `event_kind` column instead.
- `event_kind` is the source-of-truth classifier with values:
  - `secondary_sale` — `NFTStorefrontV2.ListingCompleted`
  - `primary_withdraw` — TS `PackNFT.Withdraw` from contract reserve
  - `primary_mint` — AllDay `PackNFT.Mint`
- `is_primary_drop` is auto-derived via the `pack_purchases_set_is_primary_drop` trigger, which flips it `true` when `event_kind ∈ ('primary_withdraw', 'primary_mint')` OR `seller` matches the `primary_drop_forwarders` registry. **Workers set `event_kind` at ingest and the trigger handles the rest.**
- Unique constraint is `(tx_hash, pack_nft_id)` for idempotent upserts.

### Primary drop event signatures

- **Top Shot** — `A.0b2a3299cc857e29.PackNFT.Withdraw` where `from = 0x0b2a3299cc857e29` (contract account). Pre-minted reserve pattern. Buyer = matching `PackNFT.Deposit.to` in same tx. `pack_dist_id` is NULL (not in event payload) and resolves on open via `pack_rips`.
- **AllDay** — `A.e4cf4bdc1751c65d.PackNFT.Mint`. Mint-on-demand pattern; every `Mint` event is primary by definition (no signer check needed). Event carries `distId` field which populates `pack_dist_id` immediately. Buyer = matching `PackNFT.Deposit.to` in same tx. `seller_address` stays NULL since there's no prior holder.
- **Pinnacle / UFC / Golazos** — event signatures are **UNVERIFIED**. No primary drop activity observed in our data and Trevor's wallet has zero history there. When a primary drop happens on any of these, **decode a tx via Flow REST to confirm the contract path before adding ingestor coverage**. Golazos moments use `A.87ca73a41bb50ad5.Golazos.Withdraw / Deposit` for transfers, but pack path is not confirmed.

### `pack-events-ingest` worker cursors

All 7 cursors:

- `topshot_pack_purchases` (forward) and `topshot_pack_purchases_backfill` (walks forward filling gap) — **both handle ALL event types** in their chunks, so no separate primary backfill is needed for TS.
- `topshot_pack_opens` and `topshot_pack_opens_backfill` — moment delivery events from pack opens.
- `allday_pack_purchases` (forward) and `allday_pack_purchases_backfill` (walks forward, auto-stops within 1000 blocks of forward cursor).
- `topshot_pack_purchases_primary_backfill` is **RETIRED** — was redundant with the TS backfill which already handles all event types. Row left in `event_cursor` at fast-forwarded position `151848205` and watchlist disabled.

### Wallet pack RPCs

- `get_wallet_pack_summary(p_wallet)` — totals split as `primary_drops` / `secondary_buys` plus currency breakdown and per-collection rollup. `primary_spent_usd` falls back to `pack_distributions.metadata->>'retail_price_usd'` joined via `pack_dist_id` (AllDay direct) or `pack_rips.dist_id` (TS post-open). Surfaces `primary_spend_unknown_count` for honest accounting when the dist / retail chain can't resolve.
- `get_wallet_pack_history(p_wallet, p_collection_slug, p_status, p_limit, p_offset)` — paginated per-pack timeline with `event_kind` per row and statuses `ripped` / `flipped` / `sold` / `held` / `other`. Uses window functions to avoid N-fold lateral joins (v3 fix).
- `get_pack_for_simulator(p_collection_id, p_dist_id)` — bundles pack metadata, grail metrics, and full edition pool with `drop_weight` / `hit_probability` where probabilities sum to 1.0 because zero-weight editions are filtered server-side.
- `get_pack_lifecycle(p_pack_nft_id)` — canonical pack timeline (purchase → ownership chain → open → pulls).

### Pack grail metrics

- `pack_grail_metrics` is a **view**.
- `pack_grail_metrics_mv` is a **materialized view** with one row per `(collection_id, dist_id)`, refreshed via the `refresh_pack_grail_metrics_mv()` `SECURITY DEFINER` function doing `REFRESH MATERIALIZED VIEW CONCURRENTLY` on hourly cron at `:23` via `/api/cron/refresh-pack-grail-metrics-mv`.
- Computed on pullable editions only (`drop_weight > 0`).
- Exposes `weighting_method` (`'uniform'` for NFL / UFC / Pinnacle / Golazos, `'weighted'` for Top Shot) and per-slot probabilities (`prob_grail_25/100/500/1000_per_slot`, `prob_ultimate_per_slot`).
- **EV methodology:** `ev_per_slot` here and `pack_ev_latest.gross_ev / slots` both use `drop_weight`-weighted FMV averages via `compute_pack_ev_per_edition_weighted`. The previous "10% trimmed-mean against equal weights" note for `pack_ev_latest` was outdated — both surfaces should now reconcile. (Stale note corrected 2026-05-24.)

### Pack rip metadata

- `pack_rips.dist_id` and `pull_value_usd` are denormalized via the hourly `backfill_pack_rip_metadata(p_limit => 500)` sweep at `:53`, which finds rips where `metadata_updated_at IS NULL OR < now() - 7 days`, resolves `dist_id` via `drop_pool` edition overlap, and sums FMV across linked `moment_acquisitions`.
- ~25% of historical rips do not resolve to a `dist_id` (drop pool coverage only goes back to April 2026), so the frontend shows "Unknown distribution" gracefully.

### Pack-pull intelligence pipeline gotchas

- `pack_drop_pool` has zero-weight rows (~13K of 118K) representing exhausted editions, so all grail metrics and the simulator pool **MUST filter `drop_weight > 0`**.
- `pack_distributions.metadata.number_of_pack_slots` coverage is **83% for Top Shot and 0% for NFL / UFC / Pinnacle / Golazos**, so the frontend falls back to live `pack-ev` API's `momentsPerPack` or a 5-slot default with an "approx" badge.
- `pack_distributions.metadata.retail_price_usd` value range: `$0` for reward / quest packs and `$2+` for paid drops. `~$1M+` values would need `/1e8` satoshi conversion but no current Top Shot values exceed that, so flat numeric reading works.
- **Quest reward / set completion packs flow through the same `PackNFT.Withdraw` / `PackNFT.Mint` events as paid drops** and get `is_primary_drop = true` correctly. UI distinguishes via `pack_distributions.metadata.retail_price_usd = 0`.

### Cron endpoints

Both endpoints use admin-auth via `INGEST_SECRET_TOKEN`:

- `POST /api/cron/refresh-pack-grail-metrics-mv` on schedule `23 * * * *` with 30s timeout.
- `POST /api/cron/backfill-pack-rip-metadata` on schedule `53 * * * *` with 30s timeout.

Both routes match the data-integrity admin-auth pattern with auth header `Authorization: Bearer ${INGEST_SECRET_TOKEN}`. **The apex domain returns 308 → www, so cron-job.org URLs must use `www.rippackscity.com`.**
