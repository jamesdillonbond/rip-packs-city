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

### July 1, 2026 (overnight pass) — GENUINE OVERNIGHT (01:03 PDT, no clock skew); shipped 0 (correct); post-ship watch on the heavy 06-30 badge-art/perf/jersey-FMV/insight-links wave ALL PASS; queued 1 (measured to DISPROVE the monitor's proposed classify-timeout fix)

Fired in-window (shell 08:02:50Z ≈ DB `now()` 08:03:51Z ≈ app-stamped sales 08:03Z / fmv 07:58Z — NO skew). Push available, no FREEZE. Sandbox clone `$HOME/rpcwork`; origin/main `811ac094` unchanged start→end. Shipped **0** (correct — the sole new candidate has no clean/safe fully-verifiable lever), reverted 0, repaired 0, closed 0. Drained 3 inbox files. Value = the independent post-ship watch + a measurement that overrode the monitor's suggested fix. Full handoff: [docs/handoff-2026-07-01-overnight-pass.md](docs/handoff-2026-07-01-overnight-pass.md).

- **Post-ship watch — ALL PASS, 0 reverts** over the heavy 06-30 daytime/evening wave (prod `705fb202` READY): badge-art CDN restore, warmup/perf, jersey-FMV refit + caller swap, pack-dist EV panel, insight-links RPC bundle, React #418 freshness-chip fix. **editions FLAT** (no writer leak); **FMV flat** (TS H+M 4,679 / AllDay 911) + `fmv_sanity_flags` 0 (jersey refit onto `editions.jersey_number` clean); new DB objects present + correctly secured (`compute_serial_fmv_jersey_model` + the new **7-arg** `serial_fmv_estimate` jersey overload = service_role-only; `get_edition_insight_links` = anon-read of already-public squeeze/deals/first-mint boards, `secdef_anon_violations []`). The perf wave (drop dead `special_serials`, bundle 3 insight-link reads into 1 RPC, Suspense-stream player Top Sales) is measurably shrinking the edition-page connection-pool-saturation class — those errors last occurred on the **superseded** `dpl_8Gu4` (06-30T22:11Z), NOT recurring on current prod. AllDay-corrected-EV dist timeouts = known DBSAT collateral (do NOT reopen).
- **Health GREEN.** security **0/0/0/0**; trust **15/15 ok** (breaches []); `detect_stalled_pipelines()` [] / `check_pgcron_recent_failures()` [] / `get_pipeline_alerts()` 2 INFO (golazos+ufc resolving_editions benign); sentinel TS-UUID-48h **17** (inert DQ4); editions FLAT (TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS H+M **4,679** / AllDay **911**; fmv_sanity 0; unmapped 29/100; DB **6,992 MB** (−103 = benign overnight vacuum); pipeline fails 24h 15 pipelines, **all 14 non-classify latest-ok=true** (transient pool contention). Vercel prod **`705fb202` READY**, 0 ERROR; runtime errors all known families, no new class. Artifacts 15, none broken/repaired.
- **NEW queued (1, sharpened) — CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (LOW-MED, CC/operator).** The `nfl_all_day` leg of `classify-acquisitions-multicollection` (hourly :06) flaps (~40% of ticks) at the SECDEF fn `backfill_acquisitions_for_collection`'s own `statement_timeout=90s` — a Merge Anti Join over ~246k priced AllDay `sales` (226,165 = `allday_studio_history_v1`, still filling) × 582k `moment_acquisitions`, LIMIT 300 scanning deep (backlog ~228k, growing). LOW impact (moment_acquisitions enrichment; NOT FMV/deal-boards/pack-EV/user-facing); flaps not stalls. **Measured to DISPROVE the monitor's suggested pure `statement_timeout` ALTER** — the route runs all work in `after()` under `maxDuration=120` and the leg already eats ~95s of it, so raising the fn cap risks silently killing the lambda before `log_pipeline_run` (visible flap → invisible failure; the 06-20 special-serial-MV anti-pattern). No missing index; a `sales(collection_id,nft_id)` composite would tax the hot ingest path. Recommended fix (CC): reduce AllDay `p_limit` 300→120–150 (likely RAISES net throughput), or coordinated fn-timeout + route-maxDuration bump. Route last touched 06-09 (not hot).
- **Carried (unchanged):** SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG, SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (night-count 2, resurfaces 07-05), REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT, BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), topshot-sales-history-backfill watchlist, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, N1, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. STEER honored: SERIAL-FMV weekly by design, evm-429 benign, DQ4 inert, studio-backfill volume expected. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 30, 2026 (overnight pass) — MONITOR-MODE (off-hours ~07:12 PDT, no clock skew); shipped 0 (correct); post-ship watch on the heavy 06-29→06-30 daytime wave ALL PASS (DB-side); CLOSED both AllDay EV dist-page timeouts; queued 1 LOW

Fired late at real **14:12Z / ~07:12 PDT** (outside 00:00–06:00; app-launch trigger). **No clock skew** (shell 14:12Z == DB `now()` 14:12Z == app-stamped sales 14:12Z, within ~25s). → MONITOR-MODE: full triage + post-ship watch, **queued instead of shipped, docs-only commit** (push WAS available). origin/main `b9aa7486` unchanged start→end. Shipped **0** / reverted **0** / repaired **0** / **closed 2**. Drained 4 inbox files. **Vercel + Sentry connectors NOT loaded this run** + web_fetch provenance-gated → post-ship watch DB-comprehensive but frontend-blind (noted; operator: reconnect Sentry). Full handoff: [docs/handoff-2026-06-30-overnight-pass.md](docs/handoff-2026-06-30-overnight-pass.md).

- **Post-ship watch — ALL PASS (DB-side), 0 reverts** over the heavy 06-29→06-30 Trevor/Cowork/CC wave. **AllDay EV matview fix (`8b4b1872`) DURABLE:** `mv_allday_pack_ev_corrected` 2,330 rows, `v_allday_pack_ev_corrected` passthrough (2,330==2,330, security_invoker=on), refresh cron `rpc-allday-ev-corrected-refresh` (jobid 28) succeeded 06:23Z+12:23Z ~6s/0 fails → page reads the fresh precompute, the per-request-aggregation timeout is structurally impossible. AllDay FMV lever jobid 19 + pack mechanics jobs 20/21/25 all latest-ok/0 fails; `v_allday_pack_market` 1,164 / `v_topshot_pack_market` 1,770 / `v_allday_pack_realized_ev` 147 (filling) resolve security_invoker=on; Pinnacle intraday floor `pinnacle_render_floor_stale_hours` **0.5h** (the 06-29 cron working; was 17.5h). Frontend-only commits (badges `9b3cf644`/`0bf99835`, account-value landing `d193778d`, SEO `ea5cb40f`/`d23f5e66`) — editions flat = no leak; deploy-READY unverified this run (connectors down).
- **CLOSED 2 (the 06-30T0610Z monitor reconcile):** ALLDAY-CORRECTED-EV-DIST-PAGE-TIMEOUT + ALLDAY-PACK-REALIZED-EV-DIST-PAGE-TIMEOUT — both fixed by daytime Cowork `8b4b1872` (matview precompute; dist page 2660ms→145ms). Monitor confirmed both Vercel timeout classes quiet since 04:03Z (pre-fix); durability re-verified DB-side this run. Do NOT re-queue/re-fix.
- **Health GREEN.** security **0/0/0/0** (snapshot + direct catalog SQL); trust **15/15 ok** (breaches []); `detect_stalled_pipelines()` [] / `get_pipeline_alerts()` 2 INFO (golazos+ufc resolving_editions benign) / `check_pgcron_recent_failures(24h)` [] (SERIAL-FMV jobid-6 aged out, resurfaces ~07-05); sentinel TS-UUID-48h **17** (inert DQ4); editions real-flat (TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518); FMV direct TS H+M **4,685** (improving) / AllDay 908, fmv_sanity 0; pipeline fails 24h 12 pipelines ALL latest-ok=true (transient); DB **7,095 MB** (+570 = the 2 new pack-market-history tables, benign/still-filling).
- **NEW queued (1):** SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG (LOW; folds into ANALYTICS-SMOKE-RESIDUAL — the route smoke test's HARD security leg cry-wolfs on a transient out-of-repo `api_probe_debug` RLS-off scratch table; verified NOT a live hole, table absent/security 0/0; CC fix = create-with-RLS the out-of-repo creator OR exclude ephemeral scratch names from the hard leg). **Carried unchanged:** SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (night-count 2, resurfaces 07-05), REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT, BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), cron→GHA-decouple pt2, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, N1, IPFS ×2. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 29, 2026 (Cowork) — Pinnacle hardening audit: shipped the render-floor freshness sentinel (closed a silent-degradation blind spot) + tombstoned 2 dead listings tables

Audited Disney Pinnacle (FMV coverage / freshness / ask pipeline). Verdict: healthier than its "least-hardened" reputation — `pinnacle_catalog` 2,272 renders, 95.7% priced, 100% art, FMV 96% <24h (daily `pinnacle-fmv-recalc` logs `pipeline_runs` now — the "writer logs no pipeline_runs" note is stale), all Pinnacle pipelines green, and the "$1 floor" is genuine (of 323 renders at $1 only 1 is contradicted by real sales; the Flowty $1 cache is dead since 06-08 and not read). One real gap found + fixed.

- **SHIPPED — `audit_20260629_pinnacle_render_floor_freshness_sentinel` (closes the render-floor silent-degradation blind spot).** The render-keyed `pinnacle_catalog.floor_ask` (2,124 renders; powers ASK_ONLY FMV + every public render/edition/set page) is full-rewritten once daily by `pinnacle_catalog_set_floor_asks` (all rows share one `floor_ask_updated_at` stamp). It had NO freshness sentinel: the existing `v_rpc_trust_health.pinnacle_ask_stale_hours` (breach 3h) reads a DIFFERENT, narrow table (`pinnacle_editions.ask`, source `pinnacle_direct`, 319 rows, written by `pinnacle-listings-reconcile`) and stays green (0.0h) while the render floor can silently freeze; `pinnacle_fmv_stale_hours` (30h) watches FMV recompute, which fails independently. Added metric `pinnacle_render_floor_stale_hours` = `max(now()-floor_ask_updated_at)` over `pinnacle_catalog`, breach 30h (matches the daily-writer FMV sentinel). Verified: 14 metrics all ok, new one reads 12.8h; `check_secdef_anon_execute_violations()` []; view still service_role-only (no anon / no `security_invoker` change). **Revert:** `CREATE OR REPLACE VIEW public.v_rpc_trust_health` minus the `pinnacle_render_floor_stale_hours` UNION ALL branch (prior def in migration history).
- **SHIPPED — `audit_20260629_tombstone_dead_pinnacle_listings_tables` (footgun tombstone, COMMENT-only).** `pinnacle_listings_direct` (0 rows, no writer — older docs wrongly name it the ASK source) and `pinnacle_cached_listings` (141 rows all <=$1 = the dead Flowty $1-floor cache, frozen 06-08) now carry `COMMENT ON TABLE` marking them dead + naming the real ask surfaces. Live code already clean (concierge reads `pinnacle_catalog`; `pinnacle-sync` stopped reading the dead cache 06-08). **Revert:** `COMMENT ON TABLE ... IS NULL` on both.
- **SHIPPED — `audit_20260629_revoke_anon_write_pinnacle_base_tables` (security parity).** 10 Pinnacle base tables (incl. `pinnacle_catalog`, `pinnacle_sales`, `pinnacle_editions`) still carried the dormant Supabase anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE grant that the May audit already removed from the core tables (`editions`/`fmv_snapshots`/`sales`). NOT a live hole (RLS on + SELECT-only policies -> writes default-denied; `check_public_security_invariants()` []), but a latent footgun. Revoked write from anon+authenticated on all 10; SELECT + service_role writes preserved; verified no anon/auth write remains on any of the 13 Pinnacle base tables. **Revert:** `GRANT INSERT,UPDATE,DELETE,TRUNCATE ON public.<table> TO anon, authenticated` per table.
- **SHIPPED — `audit_20260629_v_pinnacle_fmv_sanity_flags` + `audit_20260629_trust_health_pinnacle_fmv_sanity_metric` (FMV correctness monitor).** The global `v_fmv_sanity_flags` / trust-health `fmv_sanity_flags` is hardcoded to the TopShot collection_id, so render-keyed Pinnacle FMV had freshness monitoring but NO correctness monitoring. Added `v_pinnacle_fmv_sanity_flags` (service_role, security_invoker) flagging `fmv_usd<=0` or HIGH/MED renders priced >3x their max 90d sale, wired into `v_rpc_trust_health` as `pinnacle_fmv_impossible_flags` (breach 3). Pinnacle FMV measured internally clean (0/1270 HIGH/MED priced >2x max sale); 15 metrics, 0 breaches. **Revert:** drop the `pinnacle_fmv_impossible_flags` UNION ALL branch from `v_rpc_trust_health` + `DROP VIEW public.v_pinnacle_fmv_sanity_flags`.
- **Doc footgun (Trevor / skill action — cannot self-edit the skill from Cowork):** the `rpc-data` skill still says Pinnacle FMV "legacy `pinnacle_fmv_snapshots` still live with many readers — don't assume retired" — stale (dropped 06-08; survives only as `pinnacle_fmv_snapshots_backup_20260608`). Update the skill's Pinnacle line in Settings > Capabilities. Truth: current per-render FMV on `pinnacle_catalog.fmv_*`; history in `pinnacle_fmv_history` (engine `pinnacle-2.0.0-render`).


### June 29, 2026 (overnight pass) — GENUINE OVERNIGHT (01:03 PDT, no skew); shipped 0 production (green night); post-ship watch on the heavy 06-28 CC wave (pack-EV sessions 6/7 + view-security hardening + trophy-slab) ALL PASS; queued 1 (serial-fmv power-model weekly 120s timeout)

Nightly pass fired in-window (08:03Z / 01:03 PDT; shell == DB `now()` == app-stamped rows 08:03Z, NO clock skew). Push available. Sandbox clone `$HOME/rpcwork`; origin/main `ad1aeb5f` unchanged start->end. Shipped **0 production changes** (correct — green night; the sole inbox candidate is FMV-adjacent, not urgent, and its outcome isn't in-run-verifiable -> QUEUED with a ready fix), reverted 0, repaired 0, closed 0. Drained 1 inbox file. Full handoff: [docs/handoff-2026-06-29-overnight-pass.md](docs/handoff-2026-06-29-overnight-pass.md).

- **NEW queued — SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (MED, DB-only fn).** pg_cron `rpc-serial-fmv-power-model-weekly` (jobid 6, `0 11 * * 0`) failed its 2026-06-28 11:00Z tick at 120.0s ("canceling statement due to statement timeout") — an 8.1s->120s regression in one week; the sibling `rpc-serial-fmv-multipliers-weekly` (jobid 5) succeeded but jumped 2.7s->78.2s. Root cause (measured read-only): the fit's `latest_fmv` CTE does a Merge-Append + Unique over ~437,673 TS `fmv_snapshots` rows (2026 partition) — already on the ideal `(collection_id, edition_id, computed_at DESC)` index, so no cheap index fix; data growth + the 11:00Z cron-rush/backfill I/O drove the cliff. Neither fit fn sets `statement_timeout`. LOW blast radius (serial-premium refinement feeding `serial_fmv_estimate`, NOT core FMV / deal boards / pack-EV); next scheduled run 2026-07-05. Not auto-shipped: FMV-adjacent + the timeout-bump's outcome can't be driven to completion within the MCP cancel window this run. **Ready fix A (result-identical):** `ALTER FUNCTION public.compute_serial_fmv_power_model(uuid,integer,integer,numeric) SET statement_timeout TO '600s';` + same on `compute_serial_fmv_multipliers(uuid,integer,numeric,integer)`. **Option B (CC, faster, logic change):** constrain `latest_fmv` to `computed_at > now() - interval '14 days'`. Ledger + handoff carry revert paths.
- **Post-ship watch — ALL PASS, 0 reverts** over the heavy 06-28 daytime CC wave (`7c7ce83a`->`ad1aeb5f`, prod `ad1aeb5f` READY): session-7 security hardening holds (invariants 0/0/0/0, `cross_collection_deals_board` security_invoker=on restored, 9 view write-grant holes stay closed, default-ACL revoke clean); the non-destructive TS pack seeder verified (`pack_distributions` TS 1990/1990 with total_minted>0, 0 zeroed — the exact regression it guarded); pack-EV/lifecycle views security_invoker=on + crons ok; trophy-slab + calibrated/reality EV deploys READY; Sentry 0/24h.
- **Health GREEN.** security **0/0/0/0**; trust **13/13** (breaches []); `detect_stalled_pipelines()` [] / `get_pipeline_alerts()` [] / `check_pgcron_recent_failures()` 1 (the queued weekly-fit timeout); sentinel TS-UUID-48h **0**; editions FLAT (TS 17,471 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS H+M **4,645** (improving from 4,604) / AllDay 905; fmv_sanity 0; DB **6,525 MB** (+134/24h benign backfill wave); Sentry **0 unresolved/24h**; Vercel prod **ad1aeb5f READY**, 0 ERROR (runtime errors = known connection-pool-saturation + heavy-query timeouts, no new crash); pipeline fails 24h ~28 all latest-ok transient; artifacts 13 active, none broken/repaired.
- **Carried (unchanged, owned/operator/gated):** WEEKLY-SURFACE-QA-PROSE, ALLDAY-V1-UNMAPPED-DRIFT, cron->GHA-decouple pt2, remaining-CC-lane, topshot-sales-history-backfill watchlist, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1 (gated/CC), Q2/Q5/Q6, N1, ANALYTICS-SMOKE-RESIDUAL, IPFS x2. STEER honored: SERIAL-FMV-MULT-CRON cadence by-design (the NEW finding is a different signal — the fit timed out, not a staleness flag); evm-429 benign; studio deep-history post-ship-watch-only.



### June 28, 2026 (overnight pass) — GENUINE OVERNIGHT (01:02 PDT, no clock skew); shipped 0 production (correct — green night); post-ship watch on the heavy 06-27 CC wave ALL PASS; fixed the stale Pinnacle-FMV table name in CLAUDE.md (the live-query footgun); closed 4

Nightly pass fired in-window (08:02Z / 01:02 PDT; shell == DB `now()` == app-stamped rows 07:56Z, NO clock skew). Push available. Sandbox clone `$HOME/rpcwork`; origin/main `38565d9a` unchanged start→end. Shipped **0 production changes** (no candidate both warranted and fully-gated low-risk — platform GREEN, the entire 06-27 CC wave verified PASS, the remaining queue is owned/operator/gated), reverted 0, repaired 0, **closed 4**, plus 1 docs-only fix (the Pinnacle-FMV table-name footgun in CLAUDE.md). Drained 2 inbox files. A quiet honest night whose value was the independent post-ship watch + a documentation footgun fix. Full handoff: [docs/handoff-2026-06-28-overnight-pass.md](docs/handoff-2026-06-28-overnight-pass.md).

- **Doc fix (the Pinnacle-FMV live-query footgun) — Known-issues #4.** The 06-28 monitor flagged that CLAUDE.md still described Pinnacle FMV as living in `pinnacle_fmv_snapshots` / algo `pinnacle-1.0.0` / "425 editions" — but that table was DROPPED 2026-06-08 (survives only as `pinnacle_fmv_snapshots_backup_20260608`; a query against it now 42P01-errors). Since this sat in a "verify before writing queries" section, it could mislead a future session into a broken query. Corrected to the live truth (re-verified this run): render-keyed `pinnacle_fmv_history` (cols `render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at`; 13,436 rows / 1,826 renders priced in 2d), engine `pinnacle-2.0.0-render`. Docs-only (CANCELED deploy via the docs ignoreCommand). Revert: `git revert`.
- **Post-ship watch — ALL PASS, 0 reverts** over the dense 06-27 daytime CC wave (`db95f76`→`16e65d7`, prod `c688f673` READY): wmc-fossil on-chain re-key (`f130face`) drove **`ts_wmc_uuid_fossils` 1748→0** + sentinel TS-UUID-48h 0; trust-rescope (`16e65d7`) trust **13/13**, unmapped 26 ok; sentinel_threshold_config (`0a684d2`) 6 rows live; concurrency guard (`611b2fb`) `pipeline_run_locks` live (316) + wallet-backfill/snapshot/lock-check-batch all latest ok; pack-lifecycle (`c688f67`) `v_topshot_pack_lifecycle` 1989 / `v_topshot_pack_realized_ev` 201 rows; AllDay current-holder resolver (`04f96f2`/`4b2c6a6`/`5caeabe`) ok/scanning (the unresolvable tail is owned ALLDAY-V1-UNMAPPED-DRIFT). Prod `c688f673` READY 0 ERROR (the 2 newer docs commits correctly CANCELED).
- **Health GREEN.** security **0/0/0/0**; trust **13/13** (breaches []); `detect_stalled_pipelines()` [] / `get_pipeline_alerts()` [] / `check_pgcron_recent_failures()` []; sentinel TS-UUID-48h **0**; editions FLAT (TS 17,471 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS H+M **4,604** / AllDay **909** (both improving); fmv_sanity 0; `ts_wmc_uuid_fossils` **0**; DB **6,391 MB** (+109/24h backfill wave, benign); Sentry **0 unresolved/24h**; Vercel prod **c688f673 READY**, 0 ERROR; pipeline fails 24h **5** (wmc-fmv-populate/offers-sweep/compute-topshot-pack-ev/lock-check-batch/topshot-buyer-backfill), all latest run ok=true (transient/recovered).
- **CLOSED 4:** TS-WMC-UUID-FOSSILS (resolved by CC `f130face` on-chain re-key 1748→0, verified 0 — a re-key not a delete, so the Trevor "do-not-delete" decision was honored); ALLDAY-FMV-POPULATE-NOOP-STALL (watchlist row already `is_active=false` → detect_stalled/alerts both [], false-positive neutralized; no DELETE needed); NEW-COLLECTORS-INSIGHTS-QA + ROOKIE-BOARD-INSIGHTS-QA (Cowork interactive live/visual leg PASS per the mount inbox note — both prod insights surfaces clean, no fixes).
- **Carried/queued (unchanged, owned/operator/gated):** WEEKLY-SURFACE-QA-PROSE (now also the rpc-live-health footer `pinnacle_fmv_snapshots` string — cosmetic; the board's CONSOLIDATED_SQL already reads `pinnacle_fmv_history`; not worth a 550-line reinstall for an unattended pass), ALLDAY-V1-UNMAPPED-DRIFT (owned), topshot-sales-history-backfill watchlist, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1 (gated/CC), Q2/Q5/Q6, N1, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. STEER honored: SERIAL-FMV-MULT-CRON by design (weekly), evm-429 benign. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 27, 2026 (overnight pass) — MONITOR-MODE (off-hours ~07:52 PDT, no clock skew); shipped 0 (correct); post-ship watch on the 06-26→27 CC wave ALL PASS; closed/reconciled 4; queued 1 DB-only + 2 insights-QA

Fired late at real **14:52Z / ~07:52 PDT** (outside 00:00–06:00; app-launch trigger). **No clock skew** (shell == DB `now()` == app-stamped sales 14:52Z / fmv 14:48Z). → MONITOR-MODE: full triage + post-ship watch, **queued instead of shipped, docs-only commit** (push WAS available). origin/main `4ecd209` unchanged start→end. Shipped **0** / reverted **0** / repaired **0**. Drained 3 inbox files. Full handoff: [docs/handoff-2026-06-27-overnight-pass.md](docs/handoff-2026-06-27-overnight-pass.md).

- **Post-ship watch — ALL PASS, 0 reverts** over the 06-26→27 CC + monitor wave (`48bee26`→`4ecd209`; the three overnight monitor ticks already PASS'd most). Independently re-verified the GHA/new-pipeline legs: `allday-badge-ingest` 2 ok runs; data-integrity + ops-monitor 504 fixes GHA-side indirect PASS (0 new Sentry, security 0/0/0/0, prod READY); Dune ownership Pipeline A **inert** (`topshot_ownership` 0 rows); 211-row `audit_20260627_remap_ts_wmc_uuid_fossils` + the net-zero `drain`/`revert` pair clean (only `audit_20260627_wmc_fossil_remap` survives, RLS-on; editions FLAT; fossils 1,748 drifting down); rookie-board + new-collectors data-layer/security verified (live-HTTP leg queued). Vercel prod **`b0a6554` READY 0 ERROR** (4 newer docs/monitor commits correctly CANCELED by the docs-only ignoreCommand). Sentry 5 stale transient flakes, 0 new; runtime errors 11 groups all long-standing benign.
- **Health GREEN.** security **0/0/0/0**; `check_pgcron_recent_failures()` []; `detect_stalled_pipelines()` **1** (allday-fmv-populate benign no-op; AllDay FMV fresh via fmv-recalc 1.7.0); `get_pipeline_alerts()` 2 (1 medium benign no-op + 1 INFO ufc_sales); trust **8/9** (1 owned BREACH unmapped 484, plateaued — owned/Declined, do NOT re-flag); editions FLAT 17,471/6,191/581/518; sentinel ts-uuid-48h **34** inert; FMV TS H+M **4,594** (improving) / AllDay 905, fmv_sanity 0; pipeline fails 24h **6** all transient/recovered (latest ok each); DB **6,282 MB** (+106 backfill wave, benign).
- **CLOSED/RECONCILED 4 (no DB change):** DRAIN-WATCHLIST (CC `89992e6` — `topshot-flowty-unmapped-drain` watchlisted); BUYERBF-PERINVOCATION-WORK (CC — clean 2×/hr, no overlap); UFC-EDITIONS-SEED-GAP (CC — 0 missing); PINNACLE-EDITION-KEY-UUID-CAST (addressed by CC `43769cc` render_id re-key + permanentRedirect, READY, post-ship PASS).
- **NEW queued (3):** **ALLDAY-FMV-POPULATE-NOOP-STALL** (LOW/DB-only; ready SQL `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allday-fmv-populate';` — removes the standing benign-no-op false-positive in detect_stalled + alerts; AllDay FMV doesn't depend on it); **NEW-COLLECTORS-INSIGHTS-QA** + **ROOKIE-BOARD-INSIGHTS-QA** (LOW; data/security/routing verified, only live-HTTP/visual leg remains — `web_fetch` provenance-blocked this run; interactive `rpc-insights-qa` close).
- **Carried:** HISTORY-BACKFILL-UNMAPPED-SPIKE (owned/Declined/plateaued), TS-WMC-UUID-FOSSILS 1,748 tail (Trevor decision; do NOT autonomously delete), ALLDAY-V1-UNMAPPED-DRIFT 475 (Trevor decision), WEEKLY-SURFACE-QA-PROSE, topshot-sales-history-backfill watchlist, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, N1, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 26, 2026 (overnight pass) — GENUINE OVERNIGHT (01:02 PDT, no clock skew); shipped 1 (on-chain backfill watchlist = the last leg of HISTORY-BACKFILL-WATCHLIST); closed 2 Trevor code-fixes; reconciled the stale ufc-studio-watchlist doc; post-ship watch on the dense 06-25/26 wave ALL PASS

Nightly pass fired in-window (08:02Z / 01:02 PDT; shell PDT == DB `now()` == app-stamped rows, no skew). Push available. Sandbox clone re-homed to `$HOME/rpcwork` (the `/tmp/rpc` uid-squash hazard recurred — stale `/tmp/rpc` owned by `nobody`). origin/main `d9e361e` unchanged start→end. Shipped **1** (fresh-subagent PASS), reverted 0, repaired 0, **closed 2**. Drained 7 inbox files. Full handoff: [docs/handoff-2026-06-26-overnight-pass.md](docs/handoff-2026-06-26-overnight-pass.md).

- **SHIPPED — `audit_20260626_watchlist_onchain_sales_history_backfills` (the on-chain leg of HISTORY-BACKFILL-WATCHLIST).** Added 5 `pipeline_cadence_watchlist` rows (600m/medium/active) for the on-chain secondary-sales deep-history backfills: `allday-sales-history-backfill`, `golazos-sales-history-backfill`, `pinnacle-sales-history-backfill`, `topshot-flowty-sales-history-backfill`, `ufc-sales-history-backfill`. Gate met (~50h banked since 2026-06-24 06:0x, 0 fails/48h, regular ~3h cadence). 600m matches the 3 `-studio-` siblings; routes log a rich `extra` every tick incl. the `below_floor` no-op path at completion, so a finite backfill that completes keeps firing+logging → won't false-positive. Fresh-subagent VERDICT PASS (5 rows correct, `detect_stalled_pipelines()` [], all 5 healthy ≤96m headroom, security invariants []). DB-only, no deploy. **Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('allday-sales-history-backfill','golazos-sales-history-backfill','pinnacle-sales-history-backfill','topshot-flowty-sales-history-backfill','ufc-sales-history-backfill');` **HISTORY-BACKFILL-WATCHLIST is now fully resolved** (studio 3-cron + ufc-studio + on-chain 5-cron all shipped).
- **RECONCILED — `ufc-studio-sales-history-backfill` watchlist was ALREADY shipped** (CC 2026-06-25 `audit_20260625_watchlist_ufc_studio_sales_history_backfill`, 90m/medium, confirmed live). The 18:11Z/21:14Z/00:14Z monitor inboxes + the focus.md "PENDING" note were stale and kept flagging it ship-eligible. Corrected focus.md so the monitor stops re-flagging.
- **CLOSED 2 (both Trevor code-fixes; the 06-26T06-20Z monitor said CLOSE, not operator re-fire):** PACK-EVENTS-CRONJOB-STALL (`80a9238b` per-chunk flush — NOT a cron-job.org problem; verified 3 live pack cursors fresh 4m, past the 03:16Z frozen tip, no cursor_stalled) and LISTCACHE-CRON-DROP / CRONJOB-ORG-TRIGGER-SURFACE-DEGRADED (`35fb466f` GHA-decouple + `d3e931d7` fmv-backfill anti-join; `detect_stalled` [], FMV fresh).
- **Post-ship watch — ALL PASS, 0 reverts** (dense 06-25/26 Trevor/CC daytime wave; the night pass shipped nothing 06-25). DQ fills (`7a978ac` TS null-thumb 8, `729bfe4` UFC null set_name 0, AllDay null player 36 = proven correct-as-NULL Draft Picks); studio+ufc-studio drains perfect dedup (allday-studio 48,247/48,247, golazos-studio 46,608/46,608, ufc-studio 813,380/813,380, onchain 8,815/8,815), ZERO unmapped spill, editions FLAT; `topshot-flowty-unmapped-drain` net-draining (retired 0, ~50/tick) — the owned BREACH `unmapped_resolution_backlog_max` fell 2370→1968→1831→1405→1180→724 this run (draining as designed — do NOT re-flag/skip/retire/raise-threshold per the ledger Declined); `d3e931d7` fmv-backfill FMV fresh/sanity 0; `59ddb6b` spork creds-gated no runtime effect (buyer-backfill 6/6 ok); alerts/concierge/panini route-only/inert.
- **Health GREEN.** security **0/0/0/0**; `detect_stalled_pipelines()` [] / `check_pgcron_recent_failures()` [] / `get_pipeline_alerts()` 1 INFO (ufc_sales, benign); trust **8/9** (1 owned BREACH unmapped draining 1180→724); sentinel TS-UUID-48h **34** (inert, < WARN 250); editions FLAT (TS 17,469 incl. +34 inert floor / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS HIGH+MED **4,560** (improving from 4,535) / AllDay 909, fmv_sanity 0; conflation 162 (owned/backfill-elevated, converges on daily remap); DB **6,115 MB** (+~680/24h backfill wave, benign, watch rate); Sentry **1** (NEXTJS-J single-event smoke transient, 11h, benign); Vercel prod **`80a9238b`** READY, **0 ERROR**/20; pipeline fails 24h **7** all transient/recovered. Artifacts 16 (2 tombstones/14 active), none broken/repaired.
- **NEW queued:** DRAIN-WATCHLIST (`topshot-flowty-unmapped-drain` un-watchlisted, gate ~24-48h, ~15h alive — ship next overnight, ready INSERT 90m/medium in the ledger); WEEKLY-SURFACE-QA-PROSE (2 stale prose strings in the `rpc-live-health` artifact — LOW/cosmetic, queued not repaired: a full-file reinstall of the monitor's own 550-line board for two sentences is the wrong risk trade for an unattended pass); topshot-sales-history-backfill watchlist (older GHA edition-queue backfill, different class, future night). **Carried:** HISTORY-BACKFILL-UNMAPPED-SPIKE (owned, drain is the fix), PINNACLE-EDITION-KEY-UUID-CAST, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron, BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, TS-WMC-UUID-FOSSILS, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 25, 2026 (overnight pass) — MONITOR-MODE (off-hours ~06:55 PDT, no clock skew); shipped 0 (correct); post-ship watch on the heaviest wave in weeks ALL PASS; closed UFC-VIDEO-RLS; offer-gap breach self-cleared mid-run

Nightly pass fired late at real ~06:55 PDT (~55 min past the 00:00–06:00 window; app-launch trigger, same as 06-23/06-24). **No clock skew this run** — DB `now()` 13:55Z matched the shell + app-stamped `sales.ingested_at` 13:52Z / `fmv.computed_at` 13:54Z (can't be future-dated). → MONITOR-MODE: full triage + post-ship watch, **queued everything, docs-only commit** (push WAS available). origin/main `79cd8e7` unchanged start→end. Shipped **0** / reverted 0 / repaired 0 / **closed 1**. Drained 5 inbox files. Full handoff: [docs/handoff-2026-06-25-overnight-pass.md](docs/handoff-2026-06-25-overnight-pass.md).

- **Post-ship watch — ALL PASS, 0 reverts** over the heaviest single-window wave in weeks (prod walked `37993a1`→`00a0330`→`1e5300fe`→`0ae1b26e`→`7be31e3`→`77f0c65`→`11c8a23`, all Trevor/CC daytime 06-24/25; prod `11c8a23` READY). **Studio-platform deep-history program** (`7be31e3` AllDay / `77f0c65` Golazos+shared `lib/studio-sales-history.ts` / `11c8a23` Pinnacle): the 3 crons each banked **4 clean ticks**; ~**124k studio sales** ingested (AllDay 30,708/261ed, Golazos 49,641/302ed, Pinnacle 44,066/688renders), external_id/render-keyed ⇒ **ZERO `unmapped_sales` writes**, **editions FLAT**, perfect dedup (distinct id==rows), fmv_sanity 0, progress tables RLS-on — the safety property the on-chain backfills can't give. **On-chain historical-sales-capture** (5 crons): all 7/7 ok ~19h; the TS-Flowty #3 leg is the owned UNMAPPED-SPIKE source. **UFC video recovery** (`0ae1b26e`): `editions.video_url` 518/518, backup table RLS-on, security 0/0/0/0. **Video-form fixes** (`00a0330`/`1e5300fe`): route-only, 0 attributable Sentry.
- **CLOSED — UFC-VIDEO-BACKFILL-AUDIT-TABLE-RLS** (the 06-24 18:06Z monitor finding): RESOLVED by Trevor's `0ae1b26e` (anon-DML-revoke repo-sync + RLS-on on `audit_20260624_ufc_video_backfill`). Verified security 0/0/0/0, table RLS-on.
- **NON-FINDING (investigated, self-cleared) — offer_edition_gap.** `offer_edition_gap_max_usd` read $192 BREACH at ~13:55Z (chain_exceeds_gql edition-grain: Larry Bird 117:4128 live $525 open edition offer vs gql $333) then **self-cleared to $0/ok by 14:02Z** when `raise_edition_offers_from_chain` (in the healthy ~20-min offers-sweep) ratcheted `edition_offers` up to match. The EXPECTED transient per the OFFER-SANITY-VIEW-REFINEMENT ledger note ("should NOT be treated as an incident"). Not queued.
- **HISTORY-BACKFILL-UNMAPPED-SPIKE — re-measured + SHARPENED (queued, night-count 2, MED/CC/operator).** Open **2370** (725→996→1338→2370, climbing each `*/3` tick), **+603 enqueued/6h vs ~0 drained (5/24h)** = accumulating with no drain; standing trust-health BREACH (`unmapped_resolution_backlog_max`). NOT corruption (rows quarantined OUT of `sales`). **Sharpened fix (now a proven template):** build `topshot-studio-sales-history-backfill` on `lib/studio-sales-history.ts` (external_id-keyed, zero unmapped — the verified AllDay/Golazos/Pinnacle pattern) + retire the Flowty #3 on-chain backfill. Off-limits sales-path + hot file + MONITOR-MODE → queued not actioned.
- **HISTORY-BACKFILL-WATCHLIST — studio gate MET (queued, night-count 2, LOW/future-ship).** The 3 studio crons each have 4 clean ticks (gate = 2) → SHIP-eligible next genuine overnight run (ready 600m/medium INSERT + revert in the ledger/handoff). On-chain 5 crons ~19h/7-ticks, nearly at the 24-48h gate. Plus **PINNACLE-EDITION-KEY-UUID-CAST** (new, LOW/CC route — edition-page `parallels`/`high_offer` uuid-cast throw for Pinnacle composite-key slugs; from the 15:14Z monitor).
- **Health GREEN.** security **0/0/0/0**; `detect_stalled_pipelines()` [] / `check_pgcron_recent_failures()` [] / `get_pipeline_alerts()` 1 INFO (ufc_sales, benign); sentinel TS-UUID-48h **0** / dupes_24h 0; trust **8/9** (1 owned BREACH unmapped 2370); editions FLAT (TS 17,435 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS HIGH+MED **4,535** (improving) / AllDay 908 (flat), reconcile, fmv_sanity 0; conflation 105 (owned, converges on daily remap); DB **5,434 MB** (+199/24h, heavy backfill wave, benign); Sentry **3** single-event smoke transients (0 new); Vercel prod **11c8a23** READY, **0 ERROR**; pipeline fails 24h **7** all transient/recovered. Artifacts 16 (2 tombstones/14 active), none broken/repaired.


### June 24, 2026 (overnight pass) — MONITOR-MODE (borderline-late ~06:41 PDT via the recurring ~5.5h clock skew); shipped 0 (correct); post-ship watch on the heavy historical-sales-capture wave ALL PASS; 1 new finding (HISTORY-BACKFILL-UNMAPPED-SPIKE)

Nightly pass fired late (scheduled 01:02 PDT; real ~06:41 PDT, ~41 min past the quiet-hours window) — the same ~5.5h sandbox/DB-clock skew as 06-23. Caught it because the first DB `now()` (08:03Z) was contradicted by app-stamped `sales.ingested_at` 13:36Z / `fmv.computed_at` 13:38Z (rows can't be future-stamped) + a `now()` re-read of 13:41Z. → MONITOR-MODE: full triage + post-ship watch, **shipped 0 to production, queued everything, docs-only commit** (push WAS available). origin/main `895e8e9` unchanged start→end. Drained 6 inbox files (all GREEN, 0 candidates). Full handoff: [docs/handoff-2026-06-24-overnight-pass.md](docs/handoff-2026-06-24-overnight-pass.md).

- **Post-ship watch — ALL PASS, 0 reverts** over the heaviest single-day wave in weeks (all Trevor/CC daytime 06-23→24, prod `37993a1` READY). **Historical-sales-capture program** (`47e83e4` AllDay route + `c967efb` AllDay cron + `37993a1` program #2-4 = 5 new `*/3h` Vercel backfill crons, all `maxDuration=300` ≤ 800): each fired **3× at every slot, all `ok=true`, 0 fail**, sane work (AllDay 113 sales/63 ed, Pinnacle 64/61, TS-Flowty 250 decoded/60, Golazos+UFC ~0 first low-vol window), no dup-key, `fmv_sanity` 0, editions FLAT. **Media recovery** (`c68b3b1`/`c0adbf1`): TS dead-media tail at **803 thumbs** (matches the one-time 1,541→803 drain), editions flat, daily cron self-heals. **AllDay Scarcity Board** (`52c4303`): `allday_scarcity_board` 6,190 rows / `security_invoker=on` / anon SELECT ok. **Edition streaming** (`d9721d0`): 0 Sentry. **Prior ASK_ONLY parity** (`9056eff`): AllDay ASK_ONLY 646 / NO_DATA 1,666 holding. **CAND-1** leak_48h 0 + special-serial-owners MV force_hashjoin 6,793 holding.
- **NEW finding — HISTORY-BACKFILL-UNMAPPED-SPIKE (queued, MED, CC/operator).** The `topshot-flowty-sales-history-backfill` (#3) enqueues edition-unresolvable Flowty-marketplace TS sales into `unmapped_sales` faster than they drain: TS open **384→725** across 3 ticks, only **3 resolved** → ACCUMULATING (not the transient the monitor predicted). Pushes `v_rpc_trust_health.unmapped_resolution_backlog_max` to a standing **BREACH (725/100)**. **NOT corruption / NOT user-facing** — rows quarantined OUT of `sales` (the 06-06Z monitor pre-authorized this framing). NOT auto-actioned (MONITOR-MODE + sales-ingest route logic OFF-LIMITS + hot file + deliberately-shipped founder feature). Fix = a drain/resolver for backfill-era Flowty rows, OR a retire mechanism (mirror the AllDay `flowty_no_edition_id` class), OR pace the #3 cron — Trevor/CC's call. Also queued **HISTORY-BACKFILL-WATCHLIST** (add the 5 backfill crons to `pipeline_cadence_watchlist` after ~24-48h banked cadence; held tonight — only 3 ticks).
- **Health GREEN** otherwise: security **0/0/0/0**; `detect_stalled_pipelines()` []; `get_pipeline_alerts()` 1 INFO (ufc_sales resolving_editions, benign); `check_pgcron_recent_failures()` 1 (thin-fmv-guard 06-23 13:30Z = known stale-pre-watch THIN-FMV-GUARD-CONTENTION, next tick 13:30Z fires after this run); sentinel TS-UUID-48h **0**; editions FLAT (TS 17,318 / AllDay 6,191 / Golazos 581 / UFC 518); FMV TS HIGH+MED **4,399** (improving) / AllDay 901 (flat), reconcile, `fmv_sanity` 0; conflation_guard 68 (high end of benign oscillation); DB 5,235 MB (+68 benign); Sentry **0 unresolved**; Vercel **0 ERROR** prod `37993a1` READY. Artifacts 16 (2 tombstones / 14 active), none drifted, none repaired.


### June 23, 2026 (overnight pass) — borderline-late genuine overnight (sandbox clock skew); repaired the rpc-live-health leak-panel artifact (CAND-1); post-ship watch on the heavy 06-22/23 wave ALL PASS; closed 5

Nightly autonomous pass fired on its 01:02 PDT schedule, but the sandbox VM clock was **~5.5h behind real time** (shell `date` 08:02Z vs DB `now()` 13:33Z; the `30 13 * * *` pg_cron firing at 13:30:00 proves real UTC ~13:33 = ~06:33 PDT, ~33 min past the quiet-hours window). Treated as borderline-late: full health triage + post-ship watch, shipped only the reversible non-production artifact repair + an idempotent maintenance refresh; NO production code/migration ships (none SHIP-eligible). Push available; origin/main `d6e17c5` unchanged start→end. Shipped **1** / reverted 0 / repaired **1** artifact / **closed 5** (daytime-CC, recorded). Drained 5 inbox files. Full handoff: [docs/handoff-2026-06-23-overnight-pass.md](docs/handoff-2026-06-23-overnight-pass.md).

- **SHIPPED (artifact repair, subagent-verified PASS) — CAND-1: rpc-live-health leak-panel predicate.** The Open-Issues "edition writer leak" panel computed `leak_24h`/`leak_48h` with `external_id !~ '^[0-9]+:[0-9]+$'`, counting the benign `::subID` parallel editions (the 06-20→22 subedition work) as a UUID-writer leak (reads ~385–1,775, WARN band) when the real hyphen-UUID leak is ~2. The authoritative sentinel (`%-%` hyphen form) was already correct — only this dashboard panel carried the stale predicate; the daytime monitor flagged it 5 consecutive ticks. Fixed both predicates → `^[0-9]+:[0-9]+(::[0-9]+)?$` (the `rpc-data` canonical-edition predicate) via the full-file `update_artifact` install (the OneDrive artifact is Read-able but NOT Edit/bash-writable, so a verified scratch reproduction was installed). **Functional proof (live SQL):** NEW predicate = leak_24h 0 / leak_48h 2 (matches sentinel 2/250); OLD buggy = 385/48h. **Reproduction integrity:** char-count 40283, OLD-form 0× / NEW-form 2×, all structural markers intact (4 `<script`/`</script>`, 10 MATERIALIZED CTEs, 9 render fns, JSON meta parses); fresh-subagent read of the LIVE installed file = VERDICT PASS. **Revert:** `update_artifact` the two predicates back to `^[0-9]+:[0-9]+$`. **Target:** rpc-live-health `leak_48h` reads ~2 (good band) next monitor tick.
- **Maintenance (not a logic change) — thin-fmv-guard manual refresh.** `rpc-refresh-thin-fmv-guard` (daily `30 13`) FAILED its 13:30Z tick (120s timeout on the `topshot_thin_fmv_editions` INSERT) but ran 6.5s yesterday and 3.9s now with a healthy fully-index-driven plan = transient contention (the same 13:30Z window also timed out `compute-topshot-pack-ev` targets at 13:31Z — a 1-min micro-cluster). Ran the existing `refresh_topshot_thin_fmv_editions()` once (0.37s, 101 flagged) to clear ~1-day staleness + confirm health. NO fix shipped. **Watch (THIN-FMV-GUARD-CONTENTION):** if the 06-24 13:30Z tick fails again → planner/timeout fix (the special-serial-MV class).
- **Post-ship watch — ALL PASS, 0 reverts.** **Item 5 AllDay+Pinnacle ASK_ONLY parity (`9056eff`, current prod):** AllDay ASK_ONLY **65→665** / NO_DATA **2269→1667** / HIGH+MED 891→**904** — exactly the predicted Step-5d floor-ask reshuffle (reconciles to 6,191), NOT a regression; Pinnacle ASK_ONLY **640** / priced-NO_DATA contradiction **684→0**. **Item 1** rep_nft_id present in entity RPCs. **Item 6** Pinnacle STALE + **Item 7** usernames landed. **`75ee62f`** UFC 518 stable / 3-arg orphan dropped / NEXTJS-A gone. **Last night's `audit_20260622_refresh_special_serial_owners_mv_force_hashjoin`** CONFIRMED durably resolved (06-22 04:13Z fail 120s → 16:13Z 4.4s → 06-23 04:13Z 4.6s). TS HIGH+MED 4328→4366.
- **Health GREEN.** security **0/0/0/0**; `detect_stalled_pipelines()` [] / `get_pipeline_alerts()` []; `check_pgcron_recent_failures()` 1 (thin-fmv-guard transient, above); trust **9/9 ok**; sentinel hyphen-UUID-48h **2/250**; editions FLAT (TS 17,318 / AllDay 6,191 / Golazos 581 / UFC 518); conflation **44** (benign accrual, remap converging 12:23Z); DB **5167 MB** (+77 benign); pipeline_runs 24h fails = evm-429 ×4 + pack-ev ×1 (13:31Z transient); Sentry **1** (NEXTJS-1Q benign transient, 17h quiet); Vercel prod **`9056eff8` READY**, 0 ERROR.
- **Closed 5 (daytime CC — recorded):** UFC-EDITIONS-SEED-GAP (`75ee62f`, UFC 518), get_user_top_owned_moments 3-arg orphan (`75ee62f`), BADGE-CATALOG-CRONJOB-DUP (`9d441ce`), N1 snapshot-institutional-wallets (verified healthy `9d441ce`, detect_stalled []), REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT (durably resolved). **Carried (unchanged):** refresh-conflated-editions cron (operator), BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, TS-WMC-UUID-FOSSILS, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 22, 2026 (Cowork) — full platform audit + drain: concierge restore, Flowty user-facing teardown, CSP-thumbnail fix, pg_cron monitor hardening

Interactive Cowork audit (Trevor): security / DB / pipelines / crons / GHA / FMV / Sentry / artifacts + scheduled tasks / Chrome QA of every main page + ~40 entity pages + mobile + the live concierge. Platform GREEN throughout. Everything Cowork-doable shipped live + verified; the rest handed to Claude Code and drained the same day (`75ee62f`). Durable facts to carry forward:

- **Concierge model retirement — restored (`f6ee7d47`).** Anthropic RETIRED `claude-sonnet-4-20250514` on 2026-06-15; the on-site concierge (`/api/support-chat`) had been erroring for ALL users ~7 days behind the generic "Something went wrong" fallback. Migrated both call sites to **`claude-sonnet-4-6`** (verified live). CC then added a `model_error` class + a `concierge-model-error` `pipeline_runs` row + a `CONCIERGE_MODEL` single-source constant so the next retirement pages immediately. **Lesson: a pinned Anthropic model snapshot gets retired — a model-not-found / 404 from the concierge is a real outage, not a transient.**
- **Flowty marketplace — fully removed from user-facing surfaces (`dbdbd0dd`).** Flowty wound down its NFT marketplace May 2026, before RPC had anything live with it. Deleted the `/out/flowty` interstitial route + all collection-page Flowty UI (Flowty Ask column, List/View/Check-Flowty links, "marketplace unavailable" states, provenance pill, flowty.io buyUrl), the moment-modal Flowty chip, the analytics Flowty deep-link button, and the analytics Flowty-marketplace timeline events. **KEPT: the historical loan-book analytics (a separate Flowty product) + the backend `flowty_*` indexer/DB plumbing. Do NOT re-add Flowty marketplace UI.**
- **"Broken" TS thumbnails were CSP-blocked, NOT gateway-dead (`7fe106d3`).** ~106/185 of the oldest Series-1 editions store art on `ipfs.dapperlabs.com`; the gateway is HEALTHY (serves a 2880px PNG) but `proxy.ts` CSP `img-src`/`media-src` omitted that host so the browser blocked them. Added the host to both directives → 0 fail. **CDN migration is DECLINED (ledger): IPFS is the canonical/only art for the 137 `::` parallels (migrating = NULL), and the 48 base editions return NOT_IN_SET from `searchEditions` (no CDN URL exists). When TS art looks broken, check the proxy.ts CSP whitelist first, not just the gateway.**
- **pg_cron monitoring hardened.** `check_pgcron_recent_failures()` (catches pg_cron failures that `detect_stalled_pipelines()` can't — it reads `cron.job_run_details`, not `pipeline_runs`) is now wired into BOTH the `rpc-daytime-monitor` + `rpc-weekly-health-check` SKILL.md health sweeps (via `update_scheduled_task`) and `focus.md`. Two fixes this session: it now reports ONLY jobs whose LATEST run failed (was flagging recovered jobs = false-positive noise; `audit_20260622_pgcron_failures_only_when_latest_failed`), and it was REVOKEd to service_role-only (shipped anon-executable; `audit_20260622_lock_check_pgcron_failures_service_role_only`).
- **Also shipped (Cowork):** pack-reality intro median (`$0.00` hardcode → dynamic, `f27bb70f`); concierge Flowty de-recommendation + FMV-version label; DELETED the duplicate `RPC Topshot Badge Catalog Sync` cron-job.org entry (GHA `badge-catalog-sweep` owns it). **CC drained the rest (`75ee62f`):** seeded 72 missing UFC editions (446→518), dropped the orphaned 3-arg `get_user_top_owned_moments`, `softIfTransientRpc` smoke-flake fix (Sentry NEXTJS-A resolved). Full record + revert paths: [docs/overnight/ledger.md](docs/overnight/ledger.md); handoffs `docs/handoff-2026-06-2{1,2}-*`.



### June 22, 2026 (overnight pass) — GENUINE OVERNIGHT (01:02 PDT); shipped 1 (DURABLE special-serial-owners MV refresh fix — `enable_nestloop=off`, 113s→3.5s); post-ship watch all PASS; closed 3 + resolved Sentry NEXTJS-1C

Nightly autonomous pass fired in-window (08:02Z / 01:02 PDT), push available (sandbox clone re-homed to `$HOME/rpc` after the `/tmp` uid-squash hazard recurred — re-clone owned by `nobody`). origin/main `6a386b2` unchanged start→end. Shipped **1** (fresh-subagent-verified PASS), reverted 0, repaired 0, **closed 3**, resolved 1 Sentry. Drained 6 inbox files. Full handoff: [docs/handoff-2026-06-22-overnight-pass.md](docs/handoff-2026-06-22-overnight-pass.md).

- **SHIPPED — `audit_20260622_refresh_special_serial_owners_mv_force_hashjoin` (DURABLY RESOLVES REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT).** The 06-22 monitor caught the new pg_cron job `rpc-refresh-special-serial-owners-mv` FAILING its first tick (04:13Z, cancelled at exactly 120.08s = the session-default `statement_timeout`; the fn proconfig `200s` can't re-arm an already-armed top-level command). **The monitor's Fix-A ("drop CONCURRENTLY → 30-60s") was disproved by measurement** — the underlying view `topshot_special_serial_owners` is **itself ~113s** (lock-free EXPLAIN ANALYZE), a planner misestimate picking a Nested Loop over ~10,888 canonical TS editions (each a wmc index scan fetching ~138 non-special serials before filtering); plain REFRESH would be ~114s = still failing at the 16:13Z daytime tick under load. Root fix: add **`SET enable_nestloop='off'`** to the SECDEF fn so the inner REFRESH plans as a hash join — **112,699 ms → ~3,500 ms (~30x)** — and **KEEP CONCURRENTLY** (no read-blocking AccessExclusive lock; runs ~34x under the 120s ceiling). Unlike `statement_timeout` (armed once at command start), planner GUCs are read per-plan, so the fn-entry proconfig governs the REFRESH's plan. **Verified (fresh subagent PASS, all 6 checks):** force-ran the exact cron path twice → both `pipeline_runs` ok=true / logged_by=fn / duration_ms **3540 & 3516**; MV freshened **6,778→6,783**; `check_secdef_anon_execute_violations()` []; ACL postgres+service_role only; off-plan EXPLAIN = Hash Join ~3.1–4.1s; all attributes preserved (SECDEF/search_path/statement_timeout/self-log). Result is plan-choice only (identical 6,783 rows). **Revert:** `CREATE OR REPLACE FUNCTION` back minus the `SET enable_nestloop` line. **Target:** the 16:13Z pg_cron tick logs ok=true. Detail + revert: [docs/overnight/ledger.md](docs/overnight/ledger.md).
- **Post-ship watch — ALL PASS, 0 reverts.** 06-21 mis-attribution closeout (conflation guard **17** converged, ts_uuid_dupes 2/200, FMV reconciles), thin-data deal flag (thin **96** / deals-low **10** / board 526), pack-sniper wave (`snapshot-pack-asks` **106/0** watchlisted, `pack_ask_state` 2,882), `next` 16.2.9 security bump (`d54f66c8`, 0 new Sentry, security 0/0/0/0 — proxy-bypass CVE class no anon hole), concierge revival (`f6ee7d47`, prod READY, 0 support-chat Sentry).
- **Closed 3 + Sentry 1.** REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT (durably resolved, above — the prior 06-22 self-log "CLOSED" was insufficient: the pg_cron path hit a *different* 120s cap and the cancel killed the fn before it could self-log); SNAPSHOT-PACK-ASKS-WATCHLIST (already watchlisted, 106/0); PACK-SNIPER-INSIGHTS-QA (read-only rpc-insights-qa on `/insights/pack-sniper` — **clean pass, no CC gap**: sitemap line 317 / OG 1200×630 / param-stripped canonical / `/api/og/*`+`/insights` anon-public / 0 hardcoded `#E03A2F` / hydration-safe freshness chips / `pack_ask_state` RLS-on). Resolved Sentry **NEXTJS-1C** (stale-cause smoke RLS-leg, quiet 16h, cause-fixed 16:13Z 06-21, security independently verified clean, regression-armed).
- **Health GREEN.** security **0/0/0/0**; `detect_stalled_pipelines()` [] / `get_pipeline_alerts()` []; trust **9/9 ok**; sentinel hyphen-48h 24/250; FMV TS HIGH+MED **4,328** (1206+3122) / AllDay **891** (254+637), both improving (TS reconcile gap 2 = benign freshly-cataloged `::` parallels, AllDay exact); editions flat (TS 17,318 / AllDay 6,191 / Golazos 581 / UFC 446); pipeline_runs 24h **13 fails** all transient/known (analytics-smoke ×5 quiet since 17:43Z, evm-429 ×5 benign, check-alerts ×1 @07:15Z isolated, refresh-special-serial-mv ×1 stale pre-fix **route** row, wallet-backfill-ufc ×1 Flow-429); DB **5,090 MB** (+67 benign); Vercel **0 ERROR** prod `f27bb70` READY; Sentry **0 unresolved** post-resolve; 16 artifacts (2 intentional tombstones), none broken/repaired.
- **Carried (unchanged):** refresh-conflated-editions cron (operator; conflation+thin-FMV guards already refresh via pg_cron `rpc-refresh-thin-fmv-guard`), BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT (23/100, trust-green), UFC-EDITIONS-SEED-GAP, TS-WMC-UUID-FOSSILS, N1 snapshot-institutional-wallets, BADGE-CATALOG-CRONJOB-DUP, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, get_user_top_owned_moments 3-arg orphan, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. STEER honored: SERIAL-FMV-MULT-CRON BY DESIGN (weekly pg_cron); evm-429 benign; allday-listing-serial-backfill 1009 WAF external. See [docs/overnight/ledger.md](docs/overnight/ledger.md).


### June 22, 2026 (Cowork) — asset-audit close-out: pg_cron MV refresh + scheduled-task/skill/artifact/memory cleanup

Closed out the 2026-06-22 Cowork asset audit. **DB (live):** `audit_20260622_pgcron_refresh_special_serial_owners_mv` moved the special-serial-owners MV refresh off the (now-disabled) cron-job.org HTTP entry onto pg_cron job `rpc-refresh-special-serial-owners-mv` (`13 4,16 * * *` UTC → self-logging `refresh_topshot_special_serial_owners_mv()`); fixes the daily false `ok=false` (gateway 120s cap on the ~125s sync refresh) that was reddening `ts-backfill-drain-serial-fmv-watch`. Revert: `SELECT cron.unschedule('rpc-refresh-special-serial-owners-mv');`. **Skills:** `rpc-data` canonical-edition predicate fixed to `^[0-9]+:[0-9]+(::[0-9]+)?$` (was dropping ~1,775 `::` parallels); new `rpc-artifact-ops` skill — both committed (handoff-2026-06-22-cowork-asset-audit) + installed. **Scheduled tasks:** `rpc-flow-ecosystem-watch` prompt fixed (verbatim Pinnacle REST URL), 14 spent one-offs deleted, all enabled tasks verified producing real output. **Artifacts:** retired `pack-drops-ev-check` + `rpc-ts-data-mission` to tombstones; fixed the `rpc-qa-scorecard` stale flowty_archive footnote. **Memory:** trimmed 12 over-budget MEMORY.md index lines back under the size cap. Verified `seed_topshot_sales_history_targets()` already service_role-only (no hole).

### June 22, 2026 (daytime, Claude Code) — drained the Cowork asset-audit handoff: rebuilt 3 skill packages, fixed the MV-refresh ok-flag false-negative (1 migration + route), shipped the `next` 16.2.9 security bump

Drained [docs/handoff-2026-06-22-cowork-asset-audit.md](docs/handoff-2026-06-22-cowork-asset-audit.md) (the CC half of the 2026-06-22 Cowork audit of skills/scheduled-tasks/artifacts — the artifact retirements + scheduled-task prompt fix + the `rpc-data`/`rpc-artifact-ops` skill-source edits were already done live by Cowork). 2 commits; tsc clean; 1 migration. Full detail + revert in [docs/overnight/ledger.md](docs/overnight/ledger.md).

- **Item 1 — skill packages rebuilt + committed.** Cowork edited the version-controlled skill sources but its sandboxed `zip` couldn't finalize archives. Rebuilt the installable `.skill` packages (each = `SKILL.md` zipped at the archive root, via PowerShell `Compress-Archive` since Git Bash has no `zip`): `rpc-data.skill` (the canonical-edition predicate now includes `::subID` parallels — `^[0-9]+:[0-9]+(::[0-9]+)?$`; the old form silently dropped ~1,775/~16% of canonical TS editions) and the new `rpc-artifact-ops.skill`. Optional hygiene: also built the missing `rpc-cron-ops.skill` (installed skill that had no repo package); kept `rpc-fmv-audit` as-is. Verified all three contain `SKILL.md` at root. (Trevor separately installs the two presented `.skill` files via Save skill — this commit is repo version-control sync.)
- **Item 2 — `refresh-special-serial-owners-mv` ok-flag false-negative FIXED (migration `audit_20260622_refresh_special_serial_owners_mv_self_log` + route).** Measured root cause from `pipeline_runs`: the only post-fix run (06-21 09:13) ran the full ~125s refresh then errored **`upstream request timeout`** at duration 125242ms — a Supabase **API-gateway** ~120s request cap on the synchronous PostgREST RPC, NOT a Postgres `statement_timeout` (the 06-21 run reaching 125s without a `"statement timeout"` error proves the fn's 200s budget governs the route path). The MV refreshed fine server-side (the daily watch saw 6,778 current rows); only the ok-flag was wrong → daily red on `ts-backfill-drain-serial-fmv-watch`. `maxDuration`/`statement_timeout` can't fix a gateway cap, so the fix moves the authoritative logging server-side: the SECDEF fn now self-logs its own `pipeline_runs` row (ok=true after the refresh COMMITs — which happens regardless of the gateway 504; ok=false on a caught error, swallowed so the row persists). The route ([app/api/cron/refresh-special-serial-owners-mv/route.ts](app/api/cron/refresh-special-serial-owners-mv/route.ts)) is reduced to a thin trigger that fires the RPC and swallows the expected gateway timeout — it no longer writes a competing `ok=false` row. CREATE OR REPLACE preserved SECDEF/search_path/`statement_timeout=200s`/grants (postgres+service_role); `check_public_security_invariants()`=0, `check_secdef_anon_execute_violations()`=[]. **Final live confirmation = the next scheduled cron run logging ok=true** (the MCP connection's own shorter cancel can't drive the 125s refresh to completion, so it wasn't force-run from this session).
- **Item 3 — `next` 16.1.6 → 16.2.9 (exact pin, + `eslint-config-next` 16.2.9).** Clears all Next.js advisories (count 16→0), incl. the App-Router **middleware/proxy bypass** `GHSA-26hh-7cqf-hhc6` + proxy cache-poisoning — directly relevant to [proxy.ts](proxy.ts). tsc clean; lockfile diff contained to next-related entries only. **The broad `npm audit fix` was REVERTED** — it bumped the `@onflow/*` chain, which broke the build (`@onflow/fcl` lost its bundled type declarations: `error TS7016`), exactly the handoff's "where non-breaking" guard. So the `defu`/`fast-uri`/`ws`/`viem` transitive HIGHs stay monitor-only (their only fix path is build-breaking `@onflow/*` bumps); the 4 remaining HIGH are the pre-existing onflow→viem→ws chain.
- **Verify (post-deploy):** deploy READY + smoke; anon-exercise the `proxy.ts` auth path (login redirect + allow-list gate) given the CVE class. The MV watch goes quiet after the next `refresh-special-serial-owners-mv` cron tick logs ok=true.

### June 21, 2026 (daytime, Claude Code) — flagged the thin-data fake-deal residual on the TS deal board (FLAG-not-suppress + alert suppression; 2 migrations)

Drained [docs/handoff-2026-06-21-deal-board-thin-variance-fmv.md]. The parallel-conflation guard killed the *conflation-driven* fake deals; this closes the last residual of the **same symptom (inflated FMV → fake discount) from a different cause: thin, high-variance sales** (WAP/mean FMV overshoots the 90d median on editions with few wide-ranging sales, so a near-median ask reads as a big "discount"). 2 `audit_20260621_*` migrations + 4 app files; tsc clean; security invariants **0**, secdef anon **[]**, `topshot_deals_vs_fmv` `security_invoker=on` preserved. Full detail + revert in [docs/overnight/ledger.md](docs/overnight/ledger.md).

- **Measured live first.** `topshot_deals_vs_fmv` = 520 deals; **precise definition (FMV >1.5× 90d median AND <15 sales/90d) = 10** (~2%, dominated by low-circ Metallic Gold LE parallels). **The handoff's cheap proxy matched only 5/10 — NOT used**; used the precise median definition computed off the hot path.
- **Mechanism — mirror the conflation guard but FLAG (LEFT JOIN) not suppress (NOT EXISTS).** No per-row LATERAL median in the hot-path view (the handoff's perf guardrail; `fmv_snapshots` has no stored median). New precomputed table `topshot_thin_fmv_editions` + SECDEF `refresh_topshot_thin_fmv_editions()` (cheap `sales_count_30d` prefilter → per-edition 90d median; ~4.5s, 96 flagged platform-wide). `topshot_deals_vs_fmv` + `cross_collection_deals_board` gain `low_confidence_fmv boolean` (TS leg = flag; Pinnacle/AllDay = false).
- **Alert suppression (the part most worth suppressing).** `dispatch_due_deal_alerts` Pass-1 gains one zero-cost `AND NOT COALESCE(b.low_confidence_fmv,false)` (reads the already-materialized board column) so flagged editions never fire a fake "51% off" push. Pass-2 (per-serial, different FMV basis) untouched.
- **UI.** [app/insights/deals/DealsBoardClient.tsx] renders a muted amber `⚠ thin data — FMV uncertain` caveat (de-emphasizing the discount) on flagged rows + methodology note; route + server page select the column. **Refresh wired into the existing `refresh-conflated-editions` route as a non-fatal sibling step — no new cron** (that one pending-operator daily guard cron now covers both honesty guards).
- **Selectivity confirmed:** thin-variance offenders flagged; genuine high-discount deals on liquid editions are NOT (Jalen Green 52%, Draymond 46% stay clean). **Deeper lever noted, NOT done:** median-anchored FMV for low-sales editions is a platform-wide pricing change, deliberately separate.

### June 21, 2026 (daytime, Claude Code) — SEO internal-linking: closed the overview hub-fan-out gap (most of the handoff was already shipped 2026-06-05)

Drained [docs/handoff-2026-06-21-seo-internal-linking.md]. Verified each item against live code first — **the handoff (read-only Cowork scope) predated/missed the 2026-06-05 internal-linking pass (`549ddfa`)**, so items 1/3/4 were already shipped; only item 2 had a real remaining gap. 1 file, additive, server-rendered, tsc clean. Detail + revert in [docs/overnight/ledger.md](docs/overnight/ledger.md).

- **Item 1 footer Browse hub — already done.** [components/SiteFooter.tsx] already renders Insights + Collections columns on every footer-bearing page (the handoff's "footer links only to social/about/pricing/legal" premise was false).
- **Item 2 overview drill-downs — the genuine gap, CLOSED.** [components/entity/PopularOnCollection.tsx] (mounted via [app/(collections)/[collection]/overview/layout.tsx], ISR 3600) fanned out to **18 leaf editions only**. Added server-rendered hub-link rows — Top Sets (12) / Players (12) / Teams (10, exhibition-filtered) / Series (12) for the 4 sports collections — so the high-authority `/overview` page now links into the set/player/team/series **hubs** (each of which itself fans out to dozens of editions = far denser crawl equity than 18 leaf links). Slugs via `slugifyName` + `isExhibitionTeamSlug` to roundtrip exactly with `sitemap.ts`. **Pinnacle skipped** (sitemap doesn't enumerate its entity hubs) — keeps edition-only fan-out.
- **Item 3 insights→entity drill-downs — already done (spot-verified).** All named boards link rows into the entity/pack corpus (deals/squeeze/rookies/first-mint/set-squeeze/serial-premiums/trophies/top-sales/underpriced-serials → edition/set/player; pack-reality → pack dist). Lone marginal gap left as-is: `cross-collection` links set names to `/insights/squeeze?set=…` not the set page (reachable elsewhere; additive risk not worth it).
- **Item 4 entity cross-links — crawl paths already work.** Edition pages link up to set/player/team + Parallel Printings + Same-Play-Other-Sets + Found-in-Packs; set/player/series pages SSR their first 100 editions as `<Link>`s via `EditionsGridPaginated`. Sibling "More from this set" grid not added (one hop away via the now-linked hubs — diminishing returns).
- **Verify (post-deploy):** `curl -s https://www.rippackscity.com/nba-top-shot/overview | grep -c '/set/\|/player/\|/series/\|/team/'` → ~0 → ≥40.

### June 21, 2026 (daytime, Claude Code) — closed the LAST mis-attribution WRITER leak (`6b9e89a`): `/api/ingest` + sales-indexer can no longer key TS sales/moments onto UUID-dupe editions

Drained [docs/handoff-2026-06-21-writer-leak-moments-feeder.md]. `f796447` fixed only the sales-indexer Step 4d; **measured post-deploy the forward writer was still leaking** UUID-edition TS sales (~30 `topshot_gql` + 4 `onchain` per 2h). Key correction to the handoff: `source='topshot_gql'` is written by **`/api/ingest`** (the live GitHub-Actions cron, every 20min), NOT the sales-indexer (which is `source='onchain'`) — so the dominant leak was a different file than the handoff named. Both deployed forward writers now guarded. 1 commit (`6b9e89a`), tsc clean, no DB change (security 0 / secdef [] / trust 9/9 unchanged). Full detail + verify/revert in [docs/overnight/ledger.md](docs/overnight/ledger.md).

- **`/api/ingest` (dominant, 30/2h):** when hydrate-at-insert can't map a UUID pair → int pair (untracked/new plays), the UUID key survived and `upsertEdition`+`upsertSale` wrote the inert UUID edition + a UUID-keyed `moments` row (which then poisons the sales-indexer's 4b feeder). Hard canonical guard added in the per-tx loop: if the key is still a UUID pair after the UUID→int redirect, resolve `set:play` on-chain via `getMintedMoment` (budgeted) and use the int pair; else **skip** the tx (never write a UUID edition/sale/moment). New `ingest-canonical-guard` `pipeline_runs` telemetry.
- **sales-indexer (4 onchain leaks + feeder poison):** 4b/4c trusted UUID-keyed moments/wmc fossils; added an `isCanonicalExtId` guard so only canonical (`^[0-9]+:[0-9]+(::[0-9]+)?$`) editions are trusted and non-canonical nfts fall through to the fixed Step 4d resolver (or are skipped), never landing on a UUID dupe.
- **Premises refined:** moments hydrator (handoff item 2) is already canonical-only (no change); Step 4d "no on-chain ids" branch (item 3) already has no UUID fallback. The `source=NULL`/empty-txhash 2020 leak is a separate historical/local-node backfill path ([scripts/flow-backfill.ts]) contained by the daily on-chain drain — out of deployed-writer scope.

### June 21, 2026 (daytime, Claude Code) — wired the recurring on-chain drain as a daily VERCEL cron (the last mis-attribution piece)

Drained [docs/handoff-2026-06-21-untracked-drain-vercel-cron.md]. The mis-attribution bug is fixed (writer `f796447`, one-time drain `f908c83`); the DB self-healer `remap_misattributed_topshot_sales()` (pg_cron `rpc-remap-misattributed-sales`, `23 */6 * * *`) converges only **wmc-resolvable** transients. The ~22 untracked-wallet strays (`stray_self_healable`=0) need on-chain `getMintedMoment`, which can only run from a deployed route (cron-job.org's 30s cap kills the on-chain calls). Added `/api/admin/drain-topshot-misattribution?rekey=1` to [vercel.json](vercel.json) crons at **`0 11 * * *`** (daily 11:00 UTC — clear of the existing crons + the 06:45–07:35Z cohort wave). A Vercel cron supplies `Bearer CRON_SECRET` (route accepts it) and the deployed route auto-injects `X-Proxy-Secret`/`TS_PROXY_URL`, so it works server-side (this is why it can't be triggered from a local/MCP session). Route `maxDuration`=300 (≤ 800 Pro cap); `vercel.json`-only change (no code), and it bypasses the docs-only `ignoreCommand` so the deploy registers the cron. Each run re-keys the strays → the pg_cron self-healer + detector refresh trend `topshot_conflated_editions` to 0 over a few days; returns 0 targets (cheap no-op) when clean. **Revert:** remove the cron object from `vercel.json` + redeploy. Detail + verify queries: [docs/overnight/ledger.md](docs/overnight/ledger.md).

### June 21, 2026 (daytime, Claude Code) — CLOSED OUT the TS sales mis-attribution bug: writer fix + on-chain drain + fmv-recalc; conflation guard 44→0, all-time same-serial collisions 1,322→0, sales-on-UUID-editions 9,218→0

Drained [docs/handoff-2026-06-21-sales-misattribution-fix-cc-prompt.md] — the 3 remaining follow-ups to the morning's remediation. End state: **conflation guard 0 (and holds), all-time same-serial collisions 0, sales on UUID-dupe editions 0**; security invariants **0** (also closed the monitor's `AUDIT-TABLE-RLS-20260621`), `check_secdef_anon_execute_violations()` **[]**, `v_fmv_sanity_flags` **0**, trust-health **9/9**. 2 commits (`f796447`, `f908c83`) + 7 `audit_20260621_*` migrations; all data changes reversible via per-row audit tables. Full detail + revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md).

- **PHASE 1 — writer fix (`f796447`).** [app/api/sales-indexer/route.ts](app/api/sales-indexer/route.ts) Step 4d GQL fallback was the still-active writer (~480 wrong rows/day; `sales_on_uuid_editions` 9,218 / 3,374 in 7d / 530 in 24h at start). It requested only GQL UUIDs, matched them against `editions.set_id`/`player_id` (RPC's INTERNAL uuid space — never matches), then fell back to a UUID-pair `external_id`, landing sales on inert UUID-dupe editions. Now requests `set.flowId`/`play.flowID` (on-chain ints; casing verified live via a proxy probe), resolves the canonical `setID:playID` `external_id`, and self-heals a genuinely-new play via `ensure_topshot_edition_stub`. **NEVER keys on a UUID pair again.** The **moments hydrator was already correct** (int-pair + stub) — no change needed (handoff premise refined). Post-deploy: 0 new sales on UUID editions across all ingest windows.
- **PHASE 2 — on-chain drain (`f908c83` route + 7 migrations).** New `/api/admin/drain-topshot-misattribution` resolves residual nfts via `getMintedMoment` through topshot-proxy → authoritative `topshot_misattrib_onchain_map` → `remap_topshot_from_onchain_map()` re-keys sales+moments (`::subID` parallels via `topshot_moment_subeditions`; moments re-key is SAFE/free-slot-only because `moments.id` is FK'd by `sales.moment_id`/`portfolio_moments` ON DELETE NO ACTION). Ran the resolution in-session from local Node (INGEST blank locally; TS_PROXY_SECRET + service-role present — the 06-20 precedent), gentle to dodge proxy rate-limiting. **Resolved 11,741 nft identities; re-keyed 10,276 sales + 1,458 moments.** Convergence was iterative: re-keying genuine serials EXPOSED latent collisions (44→78), then resolving parallels (`getMintedMoment.parallelID`, 946 found) + cataloging 334+ missing `::subID` editions drove it 78→51→27→2→**0**. Also hardened the 3 prior `audit_topshot_*_20260621` tables (RLS+REVOKE) → invariants 0.
- **PHASE 3 — fmv-recalc.** 5,990 source+target editions affected. Triggered the canonical route (CRON_SECRET, offset 0, the most-recently-traded swath) — repriced 4,146 editions, `fmv_sanity_flags` stayed 0, spot-checks correct (Series-1 Base targets 2:71 HIGH $19.69, 2:156 MEDIUM $16.50). The long tail reprices via the daily canonical sweep + force-stale cron.
- **Operator follow-ups.** (1) Wire the daily guard refresh to the new fast **`refresh_topshot_conflated_editions_detector_only()`** — the full `refresh_topshot_conflated_editions()` self-healer scan now exceeds its 120s timeout and is redundant post-drain+writer-fix (the daily cron was never wired — only 1 failed run ever, 06-20). (2) **DONE 06-21** — `/api/admin/drain-topshot-misattribution?rekey=1` wired as a daily Vercel cron (`0 11 * * *`) for the untracked-wallet stray residual; see the entry above. (3) Force-stale cron to finish repricing the 5,990.



Probed the deferred "26-edition residual" instead of quarantining it (Trevor: "figure out what these are… don't stop until you have the right answer"). It was NOT 26 cheap commons — the 27 guard editions were the only fraction the 365-day same-serial detector can see of a broad, **still-active** mis-attribution where `sales.edition_id` is wrong (the moment truly belongs to a different play, usually same player, true edition mostly Series-1 Base). **Proven by 9 direct on-chain `TopShot.Collection.borrowMoment` reads** — every one matched `wmc.edition_key` and contradicted the recorded sale edition. Mechanism: [app/api/sales-indexer/route.ts](app/api/sales-indexer/route.ts) resolves edition once at ingest (`wmc→moments→GQL`) and never re-resolves, inheriting corruption from the pre-2026-05-26 wmc-canonicalize era, the canonically-corrupt `moments` feeder, and a GQL fallback that maps GQL UUIDs onto inert UUID-dupe editions (live `onchain` source 5.37% wrong, `topshot_gql` 68.7%). Remediation (all reversible via per-row audit tables; 5 `audit_20260621_*` migrations): re-keyed **9,336 sales** + **2,842 moments** to canonical on-chain truth where wmc is unambiguous (wmc is itself ~3% corrupt — 10,280 dup edition+serial groups — so 106 ambiguous re-keys were reverted/deferred, not guessed); durable self-healing `remap_misattributed_topshot_sales()` now runs inside `refresh_topshot_conflated_editions()` so the tracked set keeps converging. **Residual (needs prod on-chain `getMintedMoment` drain — environment-gated): 113 editions / ~2,567 nfts held by untracked wallets;** guard honestly shows 44 (365d) and suppresses them from deal boards. Open follow-ups: the on-chain drain, the writer fix, and `fmv-recalc` of the affected editions. Full detail + revert paths: [docs/scoping-2026-06-20-26-edition-misattribution.md](docs/scoping-2026-06-20-26-edition-misattribution.md) + [docs/overnight/ledger.md](docs/overnight/ledger.md).

### June 21, 2026 (overnight pass) — GENUINE OVERNIGHT (01:03 PDT); shipped 0 (correct); 0 closed; post-ship watch on the heavy 06-20 Stage B/Phase 3/Phase 4 wave all PASS; sharpened the special-serials MV-cron finding

Nightly autonomous pass fired in-window (08:03Z / 01:03 PDT) with push available (sandbox clone `$HOME/rpc`; origin/main `0ad6f6a` unchanged start→end). Shipped **0** production changes (no candidate both warranted and fully-gated low-risk — every queued/candidate item is off-limits CC route logic / operator cron-wiring / Trevor / destructive SQL, or gate-unmet), reverted 0, repaired 0, closed 0. Drained 5 inbox files (all 5 monitor ticks GREEN / 0 net-new). A quiet honest night whose value was the independent post-ship watch + health verification + a sharpened operator finding. Full handoff: [docs/handoff-2026-06-21-overnight-pass.md](docs/handoff-2026-06-21-overnight-pass.md).

- **Post-ship watch — ALL PASS, 0 reverts.** Re-measured the entire 06-20 daytime CC wave (the Stage B / Phase 3 / Phase 4 parallel-conflation program, ~20 commits `979d06f`→`592e725`) ~16h after the last commit + last night's allday-serial watchlist. **Phase-4 conflation-leak fix (`592e725`)** HOLDING: `topshot_conflated_editions` guard = **27** (converged, not drifting), safe-DELETE fix live (`refresh_topshot_conflated_editions()` `has_where=true`, confirmed via `pg_get_functiondef`), `remap_topshot_base_keyed_parallel_sales()` present; `topshot-sales-history-backfill` 11/0. **Phase 3a** `topshot-subedition-circulation-backfill` 3/0 (last 22:05Z). **`topshot-buyer-backfill`** 47/0, **max 608s** (BUYERBF-PERINVOCATION-WORK holding, no creep). **`allday-listing-serial-backfill`** 8/0 (last night's watchlist validated). Spine indexers all 72/0 fresh; `fmv-recalc` 92/0. **FMV de-blending working as Stage B intends:** TS HIGH+MED **3332→4247**, AllDay **852→874**, reconciles EXACTLY to editions (TS 16,933 = 15,543 + 1,390 `::`; AllDay 6,191).
- **Health GREEN.** security **0/0/0/0**; `detect_stalled_pipelines()` **[]** / `get_pipeline_alerts()` 1 INFO (golazos resolving_editions, long-standing); trust **9/9 ok**; sentinel TS-UUID-48h **22** (< warn 250, inert DQ4 leak); pipeline_runs 24h **10 fails** all transient/known (evm-429 ×7 benign, alerts-dispatch ×1 isolated, analytics-smoke ×1 recovered, refresh-conflated-editions ×1 @15:17Z pre-fix); Sentry **1 unresolved** (NEXTJS-A smoke transient, 1 event 11h ago, FMV verified fresh, 0 new); Vercel prod **`592e725` READY**, **0 ERROR**; DB **5,023 MB** (+124/1.5d benign); 16 artifacts (none RETIRED), monitor-validated backing objects return rows, none broken/repaired. open `unmapped_sales` 46→**59** (known ALLDAY-V1-UNMAPPED-DRIFT accrual, held out of `sales`).
- **Sharpened finding (operator) — REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT is a disabled cron, not just gate-unmet.** The fix is fully deployed AND sufficient (`3613a94` route maxDuration 240 + fn `statement_timeout` 200s; refresh ~150s fits). But `refresh-special-serial-owners-mv` has logged **2 runs ever** (both pre-fix failures 06-20 00:32Z/02:16Z) and **0 since 02:16Z** (~30h) — the cron-job.org entry was almost certainly paused during the failure window and never re-enabled. NOT on `pipeline_cadence_watchlist`. LOW blast radius (MV refreshed 22:11Z 06-20, board ~10h stale, latest-seen-captioned; deliberately NOT manually refreshed tonight to avoid masking the signal). **Operator: re-enable/verify the cron → confirm first ok tick → night pass watchlists it.**
- **Carried (unchanged):** refresh-conflated-editions cron (operator wire daily cron), BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, UFC-EDITIONS-SEED-GAP, TS-WMC-UUID-FOSSILS, N1, BADGE-CATALOG-CRONJOB-DUP, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, get_user_top_owned_moments 3-arg orphan, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. STEER honored: SERIAL-FMV-MULT-CRON BY DESIGN (weekly pg_cron), evm-429 benign. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### June 20, 2026 (daytime, Claude Code) — Phase-4 conflation-drift root cause: history-backfill made subedition-aware + durable remap wired; parallel-conflation leak eliminated

Drained [docs/handoff-2026-06-20-conflation-drift-history-backfill-leak.md](docs/handoff-2026-06-20-conflation-drift-history-backfill-leak.md). The handoff diagnosed the rising conflation (46, drifting up) as the `topshot-sales-history-backfill` (`ts_history_backfill_v1`) keying parallel-moment sales onto the BASE edition instead of `::subID`. Confirmed (73 stranded sales, 73/73 from that source) and fixed; then drove the *parallel-driven* conflation to zero. **Refinement from direct measurement:** ~27 of the 46 is a SEPARATE, pre-existing class (Standard-Standard mis-key on old no-parallel Series 1/2 commons = the F1-F3 batch, sign-off-gated + 1 UUID-base fossil), NOT the parallel leak — so conflation lands at 27, with `remaining_remappable_strands`=0. tsc clean; `check_public_security_invariants()`=[], anon violations=[], trust-health 9/9. Full detail + revert paths: [docs/overnight/ledger.md](docs/overnight/ledger.md).

- **Route fix** ([app/api/cron/topshot-sales-history-backfill/route.ts](app/api/cron/topshot-sales-history-backfill/route.ts)): new `redirectParallelSales` resolves each sale's `nft_id` against `topshot_moment_subeditions` and redirects parallel sales onto their `::` edition before insert (mirrors the forward-path `::` logic); dedup pre-filter widened to span the redirected editions.
- **Durable remap** (`audit_20260620_remap_base_keyed_parallel_sales_fn` → `remap_topshot_base_keyed_parallel_sales()`): source-agnostic sweep of any base-keyed parallel sale onto its `::` edition, **wired into the daily `refresh-conflated-editions` cron** (runs before the guard refresh) so conflation converges instead of drifting. Plus the 73-row one-time cleanup migration.
- **On-chain backlog drain** (in-session, local Node → Flow REST `getMomentsSubedition`): resolved 1,615 historical-sale nfts the held-nft resolver never covered (232 parallels) + cataloged 16 residual `::` editions (`audit_20260620_catalog_residual_subedition_editions`) — that's why the table-only fix couldn't converge alone.
- **Operator follow-up:** the route redirects only table-KNOWN parallels at ingest (Vercel egress can't reach Flow REST). To fully stop transient re-strands, extend the `backfill-topshot-subeditions` resolver to cover historical-SALE nfts (not just held). The F1-F3 mis-key residual stays sign-off-gated.

### June 20, 2026 (daytime, Claude Code) — Phase 3 of the parallel-conflation program: authoritative per-parallel circulation (route + Vercel cron), per-parallel owners MV + serial-FMV re-fit unblocked, MV-refresh timeout fixed; Phase 4 guards HELD (not converged)

Drained [docs/handoff-2026-06-20-remaining-work-cc-prompt.md](docs/handoff-2026-06-20-remaining-work-cc-prompt.md). **Critical reconciliation first:** that handoff predates the committed work — its Phases 1 (Stage B catalog+remap) and 2 (parallel edition pages) were ALREADY shipped (`979d06f`/`583a283`) and verified in-DB (1,374 `::` editions w/ subedition_id + circulation, sales/wmc/moments remapped, trust-health 9/9, invariants 0). Re-running them would have been destructive double-work, so this pass executed the genuinely-remaining **Phase 3** and assessed **Phase 4**. tsc clean throughout; `check_public_security_invariants()`=0, `check_secdef_anon_execute_violations()`=[], trust-health 9/9 at close. Full detail + revert paths: [docs/overnight/ledger.md](docs/overnight/ledger.md).

**VERIFIED end-to-end in-session** (3 Vercel-cron fires, last 22:05 UTC): GQL returns `set.flowId=0` on subedition rows but `play.flowID`/`parallelID`/`circulationCount` are correct, so the match keys on **(play, parallelID)** (unique across the 1,352 `::` editions). Final run **matched 1,221/1,352, updated 711** circulation_count off the floor (Traoré Hexwave `233:8121::19` → circ **25**). Owners MV de-contaminated (false `perfect` **1,006→470**, `#1` 426). Serial-FMV re-fit: power-model `perfect` bucket **n 41→142, r .737→.824**; multipliers **37→50**. Also fixed `refresh_topshot_conflated_editions` (`DELETE`→`DELETE … WHERE true`, `audit_20260620_refresh_conflated_editions_safe_delete`) so the guard cron can be wired (it errored via the route under `sql_safe_updates=on`).

- **Phase 3a — authoritative per-parallel circulation (NEW [app/api/admin/backfill-topshot-subedition-circulation/route.ts] + Vercel cron).** Stage B seeded `::` `circulation_count` from the max-observed-serial FLOOR. Confirmed against the live TopShot contract source that `getNumberMintedPerSubedition` is on the resource-bound `SubeditionAdmin` (no public contract view → on-chain read impossible); true per-parallel gross mint comes only from GQL `searchMarketplaceEditions` (`parallelID` + `circulationCount`), the proxy-gated path. The route does the proven full-catalog cursored sweep (badge-sync's `CATALOG_QUERY` shape — confirmed to return `parallelID`), maps `(set:play:parallelID)→circulationCount`, early-exits when all 1,374 `::` triples match, and **GREATEST-raises** `circulation_count` (never below the observed serial floor — keeps `#N/N` honest even if GQL reports net-of-burn). `::` rows only. Multi-auth (RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN | CRON_SECRET); driven by a **daily Vercel cron** (`vercel.json` `10 21 * * *`) so Vercel injects the secret automatically (the session is tokenless and the GHA path was blocked by the gh PAT lacking `workflow` scope — the Vercel cron is the secret-free trigger). `?probe=1` reports the parallel distribution without writing.
- **Phase 3b — per-parallel special-serial owners.** No rebuild needed — `topshot_special_serial_owners` already joins remapped `wmc.edition_key → editions.external_id` and tags `perfect = serial==circulation_count`, so it's per-parallel-correct by construction; the MV was just **stale** (0 `::` rows, last refresh predates the remap). Root blocker = `REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT`. Fixed: `audit_20260620_special_serial_owners_mv_refresh_timeout_200s` (fn `statement_timeout` 180→200s) + route `maxDuration` 120→240 ([app/api/cron/refresh-special-serial-owners-mv/route.ts]); MV then refreshed (via MCP) to populate parallels + correct `perfect` flags once 3a's circulation lands.
- **Phase 3c — serial-FMV per-parallel = RE-FIT the existing model on cleaned data, NOT a new mixed-effects model.** `serial_fmv_estimate` is parameter-driven (caller passes circulation + base FMV), so a `::` moment is already per-parallel-correct once 3a fixes circulation + fmv-recalc reprices the `::` base FMV (canonical writer only — ledger-locked, NO bespoke FMV writer). `compute_serial_fmv_power_model` already keys `perfect = serial==circulation_count`, so it improves automatically; Phase 3c = re-run it + `compute_serial_fmv_multipliers` after 3a. **The full multi-factor pooled hedonic model (player×badge×set×series×parallel) stays DATA-GATED per the strategy doc — ~1,330 #1 + floor-contaminated perfect sales; the remap re-attributes but does not ADD sales, and the sales-completeness backfill is still draining. Fitting now would be overfit — documented, not built.**
- **Phase 4 — interim conflation guards HELD (not converged).** Conflation = **46** in 365d (re-refreshed the stale guard table, was 39). Forward keying is live (2,147 parallel sales ingested in 3 days) but conflation drifted 30→39→46 (slightly rising, not →0) — new parallel sales occasionally land on a Standard row before its `::` row exists. The directive itself said Phase 4 happens "once converged"; tearing the guards down now would re-expose those editions' fake deals/premiums. **Teardown gate:** conflation → ~0 stable (needs an auto-remap of newly-mislanded sub-sales or a periodic historical-remap re-run). Boards healthy (TS deals 536 / serial-premiums 183, 4 flagged / perfect 11, 1 / underpriced 14).
- **OUT OF SCOPE (accepted, per handoff):** the 2020-22 buyer/seller gap (no free recovery source) and the Vaultopolis re-packs feature. **Operator items:** wire the daily `refresh-conflated-editions` cron + the weekly `refresh-serial-fmv-multipliers` cron; the circulation backfill self-runs via the Vercel cron.

### June 20, 2026 (daytime, Claude Code) — Phase 1 Stage B CATALOG + REMAP: 1,374 `::` parallel editions cataloged + sales/wmc/moments re-keyed (conflation fingerprint 676→30)

Executed the coordinated Stage B step on the complete `topshot_moment_subeditions` table — the historical subedition split that de-conflates parallels. **Catalog FIRST, then atomic remap** (never half-mapped). 2 DB migrations + 1 route change; security 0/[], trust-health 9/9 throughout.

- **Catalog (`audit_20260620_catalog_topshot_subedition_editions`):** created **1,374** `editions` rows, one per (base setID:playID, subedition_id>0) → `external_id = setID:playID::subID`, cloning base metadata + `subedition_id`/`subedition_name` (from on-chain `TopShot.getAllSubeditions()`, authoritative — 19=Hexwave/20=Jukebox/…/22=Omega) + per-parallel `circulation_count` = max observed serial (a documented **floor**; `getNumberMintedPerSubedition` is resource-bound, not publicly readable — true circ comes from GQL `searchEditions`, queued). Art (`thumbnail_url`/`video_url`) left NULL → filled by the now-subedition-aware art backfill. **Revert:** `DELETE FROM editions WHERE collection_id='95f28a17-…' AND external_id ~ '::';`
- **Remap (`audit_20260620_remap_topshot_subedition_sales_wmc_moments`):** one atomic txn repointed **17,052 sales + 29,027 wmc + 11,651 moments** for the 34,442 parallel nft_ids onto their `::` editions. dup-serial conflation detector **676 → 30** (0.3% of recently-traded); Traoré 233:8121 family now 0 dup-serials (Standard 34/Hexwave 7/Jukebox 4), Standard de-blended to ~$19 typical (was blended $45.83). **Revert:** repoint back to base via `topshot_moment_subeditions` join (full SQL in the ledger).
- **Art route subedition-aware** ([app/api/admin/backfill-topshot-onchain-art/route.ts](app/api/admin/backfill-topshot-onchain-art/route.ts)): parses `::subID` from `external_id` → `getCIDs(set,play,subID)` so the cron fills each parallel's OWN art and can never write Standard art onto a `::` row.
- **FMV recompute = canonical `fmv-recalc` only** (ledger-locked): de-blended Standard + the `::` rows reprice on the normal cron sweep (no bespoke FMV writer). Interim conflation guards stay until convergence (Phase 4 removes them). **Could not force-trigger** fmv-recalc in-session (INGEST token blank locally / not exposed) — repricing is cron-driven; data fix is verified correct.
- **Phase 2 SHIPPED (same session):** parallel-aware edition pages — `get_edition_subedition_siblings` "Parallel Printings" ladder (Standard $21 · Hexwave $35 · Jukebox $59, de-blended per-parallel FMV), per-parallel hero chip, self-canonical `::` pages, sitemap auto-includes them. **Subedition-aware offers** (`get_edition_high_offer`): an edition-level OffersV2 offer is fillable by ANY printing → surfaces on every parallel page; the blended edition floor is suppressed on `::` pages (not a per-printing ask). Also refreshed the conflation guard **741→39** (un-suppressed ~700 de-blended editions; deal board 447→538).
- **Queued (this program):** authoritative per-parallel circulation (GQL `searchEditions` — needs topshot-proxy access; max-serial floor meanwhile); bulk per-parallel art fill (subedition-aware route done, runs on cron); Phase 3 per-parallel owners MV + serial-FMV model (gated on authoritative circ — perfect-serial flags depend on it); Phase 4 guard teardown post-convergence. **Operator:** wire the daily `refresh-conflated-editions` cron. Full detail + revert paths: [docs/overnight/ledger.md](docs/overnight/ledger.md).

### June 20, 2026 (daytime, Claude Code) — Phase 1 Stage B FOUNDATION: on-chain TopShot subedition resolution COMPLETE (247,129 moments / 34,442 parallels / 0 errors)

Stood up + fully drained the historical SubEdition (parallel) resolver — the foundation that unblocks splitting the 741 conflated `setID:playID` editions into one row per parallel. **Additive only** (records `nft_id → subedition_id`; does NOT yet touch sales/wmc/editions — catalog + remap are the strictly-downstream next step, never half-mapped). Verified the on-chain mechanism at the contract level (`TopShot.getMomentsSubedition(nftID): UInt32?` is a contract-level pure map lookup → one Cadence script batches an ARRAY of nft_ids → `{nft_id: subeditionID}`, hundreds/call), then drove the full drain from local Node (Flow REST public reads + service-role writes; `INGEST_SECRET_TOKEN` is blank locally so the edge fn can't self-trigger). **Result: 247,129 resolved / 0 errors / 0 pending; 212,687 Standard (86%) + 34,442 parallel (14%, matching the handoff's ~14% ambiguous); 19 distinct parallels across 730 base editions.** Both proven Traoré nfts correct (51319360→20 Jukebox, 51321019→19 Hexwave). Shipped: 3 migrations (`audit_20260620_topshot_moment_subeditions_table_and_seed` table+seed, `_get_topshot_subedition_targets_rpc` text[] target selection, `_apply_topshot_subeditions_rpc` UPDATE-only apply) + edge fn `backfill-topshot-subeditions` v2 (verify_jwt off, Bearer INGEST, logs `topshot-subedition-backfill`). Full revert paths + the exact catalog→remap→FMV next-step plan in [docs/overnight/ledger.md](docs/overnight/ledger.md) Shipped. **NEXT (own focused pass):** catalog 1,374 `::` editions (clone base metadata + subedition_id/name + per-parallel circ from max-serial + per-parallel art via `TopShotIPFSResolver.getCIDs`), THEN remap `sales.edition_id`/`wmc.edition_key`/`moments.edition_id` by nft_id, THEN recompute per-parallel FMV — catalog+remap land together; then verify dup-serial signature gone + Traoré Standard ≈ $23 + trust-health 9/9. Interim conflation guards stay until convergence (Phase 4 removes them). Plan: [docs/handoff-2026-06-20-remaining-work-cc-prompt.md](docs/handoff-2026-06-20-remaining-work-cc-prompt.md).

### June 20, 2026 (overnight pass) — GENUINE OVERNIGHT (01:02 PDT); shipped 1 (AllDay-serial watchlist); closed ALLDAY-SERIAL-BACKFILL-CRON; measured the 04:38Z special-serials MV-refresh fix as INSUFFICIENT; post-ship watch on the dense 06-19/20 wave all PASS

Nightly autonomous pass fired in-window (08:02Z / 01:02 PDT) with push available (sandbox clone `$HOME/rpc`; origin/main `8760bda` unchanged start→end). Shipped **1** monitoring migration (fresh-subagent PASS), reverted 0, repaired 0, **closed 1**. Drained 5 inbox files. A quiet honest night whose value was the independent post-ship watch + a hard measurement that exposed an incomplete fix. Full handoff: [docs/handoff-2026-06-20-overnight-pass.md](docs/handoff-2026-06-20-overnight-pass.md).

- **SHIPPED — `audit_20260620_watchlist_allday_listing_serial_backfill`.** Added a `pipeline_cadence_watchlist` row for `allday-listing-serial-backfill` (max_silent_minutes 600, severity medium) so `detect_stalled_pipelines()` catches its 3-hourly (:34) cron if it dies. Gate met: 2 consecutive ok ticks (03:34Z = 37 serials, 06:34Z = 0 new/0 errors) after `18897fd` moved the serial source on-chain (`AllDay.borrowMomentNFT`); 600m = ~3 missed ticks + grace. Verified `detect_stalled` stays `[]` (silence 110m < 600m); fresh-subagent PASS on all 4 checks. Revert: `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allday-listing-serial-backfill';`. **CLOSED ALLDAY-SERIAL-BACKFILL-CRON** (1009 WAF block gone since `18897fd`; `allday_moment_serials` 2→39; deal-board `low_ask_serial` populated).
- **NEW measured finding — REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT (queued, MED).** Today's CC Special-Serial-Owners MV-refresh cron got a fix at 04:38Z (`audit_20260620_refresh_special_serial_owners_mv_timeout_180s` — pins the SECDEF fn `statement_timeout='180s'`). Timed the refresh through the exact fn the cron calls: `REFRESH MATERIALIZED VIEW CONCURRENTLY topshot_special_serial_owners_mv` ran **>135s** > the route's `maxDuration=120` — so the after() lambda is killed at 120s before the refresh completes AND before `log_pipeline_run`, converting the prior logged ok=false into a **SILENT** no-log failure. Necessary-but-insufficient. Fix queued for CC: route `maxDuration` 120→~200 (keep CONCURRENTLY) + fn 180→~210, OR DB-only CONCURRENTLY→plain REFRESH (CC design call). **Manually refreshed the MV tonight** so the board serves current data (5,929 rows). NOT shipped: route hot file (`93ff06c`, ~8h old); option B reverses CC's deliberate CONCURRENTLY choice; LOW blast radius.
- **Post-ship watch — ALL PASS, 0 reverts.** offer-fill→sales (`8ffb291`/`06ad6e8`/`78ca042`/`c3a13a1`): `source=offer_fill` **4,469 sales / 4,469 distinct tx** (0 dup), FMV reconciles EXACTLY, `fmv_sanity_flags` 0, `ts_uuid_dupes_24h` 0, GHA `?sync=1` draining (+235). AllDay on-chain serial (`18897fd`): 1009 gone, 2 ok ticks. Historical spork buyer lane (`cd92ec9`) LIVE+healthy (120/run buyers+sellers+exec, 0 decode_failed, ~28s, walking the 2024 tail). Special-serials surface healthy (MV 5,929, 0 Sentry, security clean). BUYERBF forward max 740.2s holding (no creep).
- **Health GREEN.** security **0/0/0/0**; `detect_stalled` **[]** / `get_pipeline_alerts` **[]**; trust **9/9 ok**; sentinel TS-UUID-48h **0**; FMV reconciles EXACTLY (TS 15,543=15,543 / AllDay 6,191=6,191), TS HIGH+MED **3,332** (up from 3,144, improving), NO_DATA 3,371 (improving), ASK_ONLY 2,421 (not over-claiming), AllDay HIGH+MED 852; editions flat (TS 15,543 / AllDay 6,191 / Golazos 581 / UFC 446); pipeline_runs 24h **14 fails** all transient/known (allday-serial ×5 pre-fix, evm-429 ×4, special-serial-mv ×2 pre-fix, 19:15–19:29Z micro-contention cluster); DB **4,899 MB** (+56/1.5d benign); Sentry **0 unresolved**; Vercel **0 ERROR** prod `c3a13a1` READY; 14 artifacts GREEN (none repaired).
- **NEW queued:** REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT (updated, night-count 2). **Carried:** BUYERBF-PERINVOCATION-WORK, UFC-EDITIONS-SEED-GAP, TS-WMC-UUID-FOSSILS, ALLDAY-V1-UNMAPPED-DRIFT, N1, BADGE-CATALOG-CRONJOB-DUP, VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, get_user_top_owned_moments 3-arg orphan, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. See [docs/overnight/ledger.md](docs/overnight/ledger.md).

---

### Older sessions

Archived to `docs/sessions/` (newest-first within each file):

- `docs/sessions/2026-06.md` — June 19 → June 1 (overnight passes + daytime CC; Candy/Solana onboarding, rewards program, FMV / pack-EV / parallel-conflation work).
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
- CI/CD: GitHub Actions workflows in `.github/workflows/` — rpc-pipeline.yml, ops-monitor.yml, pipeline-sentinel.yml, alert-checker.yml, allday-ingest.yml, badge-sync.yml, pinnacle-owner-discovery.yml, ts-listing-ingest.yml, smoke-tests.yml.

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

## Cron schedule (cron-job.org)

23 active pipelines, `*/20` cadence dominant. `/api/admin/prune-pipeline-runs` daily prune keeps `pipeline_runs` ~9.5K rows. Notable jobs:

- Sales-indexer chained → AllDay-unmapped-resolver (every 20min, NOT its own cron entry).
- HybridCustody events — every 20min.
- Seed-wallet-refresh — every 6h.
- Flowty analytics MV refresh — every 20min.
- Sync-nba-odds — every 60min during 22:00 UTC → 06:00 UTC.

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

- **Flowty shut down its NFT marketplace (~2026-05-13).** The external Flowty event indexer, `flowty_loans` / `flowty_loan_events` ingest, the Flowty analytics materialized views, the Flowty leg of the sniper feed, the `flowty-proxy` edge function, and all Flowty-sourced ASK/FMV inputs are now frozen. The "Flowty API", sniper-feed, and worker sections of this file describe what is now legacy/dead infrastructure pending a deliberate teardown. `flowty_loan_events` going cold on 2026-05-11 is expected behaviour, not a regression.
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

1. Flowty teardown — archive the now-dead Flowty indexer / analytics MVs / `flowty-proxy` / sniper buy-leg infrastructure. (The Market/Sniper frontend Flowty UI was already removed in the May 23 reframe.)
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
