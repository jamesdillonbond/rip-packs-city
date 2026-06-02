# Rip Packs City — Claude Code AI Assistant Configuration

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

### June 2, 2026 (overnight pass) — OFF-HOURS + NO-PUSH monitor run; shipped nothing; platform green; caught a real stall (institutional-wallets) + re-opened C2; queued P1+S1

Nightly autonomous pass fired 06:29 local PDT (~29 min past the 00:00–06:00 window) → MONITOR-MODE; `git push` had no credentials + bot clone unmounted → NO-PUSH; all outputs written to disk uncommitted. Shipped nothing; no auto-revert warranted. Full handoff: [docs/handoff-2026-06-02-overnight-pass.md](docs/handoff-2026-06-02-overnight-pass.md).

- **Post-ship watch GREEN — nothing reverted.** New prod deploy since the last monitor sweep: `340c7d59` (UI — scrub Flowty "By Collectors" tagline, responsive footer, insights KPI 0-flash), deploy `dpl_GtxW2hNUFifGn2HHsMuVvTDLqXgD` READY, landed ~06:24Z via the bot-clone identity; no new Sentry since. `dadcc57` (H1–H6 + `cross_market_ask` migration) clean. 20/20 prod deploys READY, 0 ERROR.
- **`detect_stalled_pipelines()` caught a real one — `snapshot-institutional-wallets` (N1, operator).** Silent 31.5h vs 30h; last success 2026-05-30 13:16Z; the last 2 scheduled runs (05-31, 06-01 06:00Z) both failed on cron-rush connection-pool timeout, and 06-02's 06:00Z daily slot never fired. Q3-class external cron — operator re-fires the cron-job.org entry (consider moving its slot off the 06:00Z peak). Low impact (0–3 rows/run).
- **Correction: C2 is NOT resolved (N2, re-opened).** The 06-01 materialized-CTE fix to `v_moments_needing_hydration` was reported resolved on 06-02 03:15Z, but `topshot-moments-hydrator` has hit the same `candidate_read … statement timeout` twice more since (06:12Z + 12:22Z 06-02, at the cron rushes). 3/138, self-recovering, no backlog. Do NOT revert the CTE fix (net-positive); needs a deeper fix (statement_timeout bump / index / further view optimization).
- **Health otherwise green.** Security 0/0 base tables; 1 anon-readable non-`security_invoker` view (S1 = `v_moments_needing_hydration`, posture regressed from Q1-era 0). FMV improving: TS HIGH+MED 880→933, NO_DATA 5109→4634; AllDay HIGH+MED 274; both fresh ~12m. Sentinel TS-UUID-48h 45 (<250). unmapped_sales 147 open (flat). DB 5966 MB. editions TS 16,334 (+26). Sentry: 2 unresolved, both 1-event/known (NEXTJS-1F /dashboard transient; NEXTJS-15 gated AllDay). All 11 Cowork artifacts healthy, none repaired.
- **Queued:** P1 (NEW — raise `evm-transfers-ingest` watchlist 60m→150m, kill the hourly `detect_stalled_pipelines()` false-positive; ready migration+revert; SHIP-eligible next in-window run), S1 (NEW — close the anon-readable SECDEF view; ready REVOKE/security_invoker migration+revert), N1 (institutional-wallets stall, operator), N2 (C2 re-open, operator/CC). Carried: Q2, Q5, Q6, Q7, Q8. Q10 confirmed shipped 06-01.

### June 1, 2026 (overnight pass) — OFF-HOURS + NO-PUSH monitor run; shipped nothing; platform green; fixed a NUL-corrupted .git/config; queued Q10

Nightly autonomous pass fired late (06:54 local PDT, ~54 min past the 00:00–06:00 window) → MONITOR-MODE; `git push` had no credentials → NO-PUSH; Trevor was actively committing (`7c1b81b` landed ~2 min before the run) → queue-only. All outputs written to disk uncommitted. Full handoff: [docs/handoff-2026-06-01-overnight-pass.md](docs/handoff-2026-06-01-overnight-pass.md).

- **Infra: repaired a corrupted `.git/config`.** Every git op failed at start with `fatal: bad config line 18` — the on-disk config had 16 trailing NUL bytes after `name = Trevor` (the exact Windows↔sandbox bridge corruption Q7's 22:30Z note predicted). Backed up to `.git/config.bak-nullfix-20260601` and truncated the NULs; git restored. Local git-internal state only (not tracked, no commit). Reinforces Q7 (sandbox needs a sandbox-native clone, not a Windows-mounted `.git`).
- **Post-ship watch GREEN — nothing reverted.** Re-measured every metric the last 24–48h of ships targeted (`7c1b81b` sitemap prune, `a79b778` audit follow-ups A1–A6, `65421e26` FMV ask-over-WAP, team-hub Phases 1–5, `/insights/market`, badge-sync). All deploys READY (20/20, zero ERROR), no attributable regression. Early sign `a79b778`'s smoke `rpcRetry` works: the 06:00Z cron rush tripped pipelines but fired no new smoke Sentry.
- **Health all green.** Security 0/0; `detect_stalled_pipelines()` `[]`; FMV writers fresh (~10m); FMV improving (TS HIGH+MED 776→880, NO_DATA 6055→5109; AllDay HIGH+MED 243→267); sentinel TS-UUID-48h 1099→40; DB 5912 MB; unmapped_sales 147 open (flat). Sentry quiet last 6h except NEXTJS-15 once ~07:54Z (gated AllDay capture, C1 watch).
- **Queued:** Q10 (NEW — add `topshot-listing-cache`+`-v2` to `pipeline_cadence_watchlist` @360m/medium so `detect_stalled_pipelines()` can see a listing-cache stall; ready migration + revert in handoff/ledger; auto-shippable next true overnight run). Carried: Q2/Q5/Q6/Q7/Q8. Doc-reconciled the rookies view name (live = `topshot_2025_rookie_index`, not `topshot_rookies_board`). Sentry NEXTJS-1B is 24h+ clean → ready for operator to mark resolved; NEXTJS-18/-17 (pack-dist tierChip server/client) real but 6d-stale, operator/CC verify.

### May 31, 2026 (overnight pass) — OFF-HOURS + NO-PUSH monitor run; shipped nothing; found a silent TopShot sales-indexer stall

Nightly autonomous pass fired late (local 08:02 UTC, outside the 00:00–06:00 window) → MONITOR-MODE; `git push` also unavailable (no GitHub creds) and `.git/index.lock`+`HEAD.lock` are un-removable from the sandbox (`Operation not permitted`), so this was a review/queue-only run with all outputs written to disk uncommitted. Full handoff: [docs/handoff-2026-05-31-overnight-pass.md](docs/handoff-2026-05-31-overnight-pass.md).

- **Post-ship watch — all green.** `6c6950b` (sitemap pagination fix) deployed READY as `dpl_9wcL2WjtViVDSFGqBnou9eoXbYUo` (current prod); the two ERROR deploys `b20e483`/`26fa6be` are superseded (transient build-infra — `a99ce2f` + `6c6950b` built clean on the same tree), so the funnel+SEO fixes are live. Q1 verified resolved (3 `topshot_pack_reality_*` views `security_invoker=on`; 0 base-table security holes). No regressions, no auto-reverts.
- **NEW — `topshot-sales-indexer` stalled since 01:32 UTC (~6.5h).** No `pipeline_runs` entries for the TS sales-indexer + listing-cache chain since 01:32/01:35Z; the 01:32 run succeeded cleanly (26 rows, no error) → stopped EXTERNAL trigger (cron-job.org), not a route crash. `sales` max `ingested_at` for `nba_top_shot` = 01:32:31Z; AllDay sales fresh (08:00Z) → TS-specific; not caused by any deploy (predates the 02:27–06:29Z deploys). No outage (prod READY, FMV fresh via fmv-recalc), but TS sales/analytics freshness degrades while it persists. Queued **Q3 (HIGH)** for the operator: re-fire the cron entry. The daytime monitor missed it because it scans `ok=false` only, not absence-of-runs.
- **Health otherwise clean.** Security 0/0; all pipeline `ok=false` rows transient-with-recovery; FMV flat-to-improving (TS HIGH+MED 776, NO_DATA ↓36 to 6055); sentinel TS-UUID-48h ↓ to 1099 (from 1707); unmapped_sales flat (144 open); DB 5827 MB. Sentry: a 6-issue smoke cluster fired once each in the 06:00–06:10Z bad-deploy window (transient, security/FMV independently verified clean); `NEXTJS-15` pinnacle-listing warning still fires post-`bd4d8c4` (that fix didn't move its metric → re-queued Q4); `NEXTJS-1B` resolved (15h clean). 10 Cowork artifacts all healthy, none repaired.
- **Queued:** Q3 (TS sales-indexer stall, HIGH), Q4 (`NEXTJS-15` re-diagnose), Q5 (smoke sales-lag threshold — do NOT blindly raise; true-positive tonight), Q6 (`evm-transfers-ingest` Base-429, LOW), Q7 (un-removable `.git` locks — blocks autonomous commits). See [docs/overnight/ledger.md](docs/overnight/ledger.md).

### May 31, 2026 — Entity detail pages: full handoff shipped (404 fix, entity pages opened to anon, JSON-LD, pack grid, montages, OG cards, hover-video)

Executed the entire code half of [docs/handoff-2026-05-30-entity-pages.md](docs/handoff-2026-05-30-entity-pages.md) (Items 1–8). Four commits, all CI + Smoke green, all deploys READY. The 3 DB migrations from the 2026-05-30 Cowork pass were already live; this session added one more.

- **Item 1 — edition pages un-404'd (`bf3f4f6`).** Edition route slugs are `setID:playID` (colon). Next delivers the URL-encoded segment (`%3A`); `get_edition_detail` only matches the decoded colon, so every TS/AllDay/Golazos/UFC edition page returned `notFound()`. Fix: `decodeURIComponent(rawSlug)` in both `generateMetadata` and the page body of `edition/[slug]/page.tsx`, plus defensive decode on set/player/series/team/moment pages and an `encodeURIComponent` on the moment→edition redirect. Same class/fix as the Pinnacle-moment colon-id bug (`fe96d4b`).
- **Opened entity detail pages to anon (`b106a27`, with Trevor's go-ahead).** **Material finding:** `/<collection>/{edition,set,player,team,series,pack}/<slug>` were auth-gated in `proxy.ts` (anon → 302 `/login`), yet `app/sitemap.ts` advertises ~20.5K of these URLs to crawlers — so Googlebot could never reach them and the whole SEO effort was invisible. Added one narrow `isPublicPath()` rule (GET/HEAD, **singular** entity segments only — matches `set` not `sets`, `pack` not `packs`, so the in-app feature pages `/…/sets`,`/…/market`,`/…/sniper`,`/…/overview`,`/…/analytics` stay behind the funnel). Also opened `GET /api/entity/*` (grid "Load more") and confirmed `/api/og/*` already public. Read-only, service-role-backed, no user-private data — same risk profile as the already-public `/moment` + `/insights`. Verified live: anon load of `/nba-top-shot/edition/2%3A188` renders "Andre Iguodala — Base Set" with Product+BreadcrumbList JSON-LD. Revert: delete the two `isPublicPath` blocks.
- **Items 2–6 (`5797235`).** JSON-LD on all six entity pages (edition→Product+offers.price=FMV, player→Person, team→SportsTeam/Organization, set/series→CollectionPage+ItemList, pack→Product) + visible breadcrumb nav ([components/entity/Breadcrumbs.tsx](components/entity/Breadcrumbs.tsx)); pack "What's Inside" thumbnail grid on the dist page (via `get_pack_contents`); hero montages ([components/entity/HeroMontage.tsx](components/entity/HeroMontage.tsx)) on the text-only Set/Team/Series heroes; Team gains a "Top Editions" grid via the new `get_team_top_editions` RPC + new route [app/api/entity/team-editions/route.ts](app/api/entity/team-editions/route.ts).
- **Items 5 + 8 DB (`audit_20260530_entity_edition_rpcs_thumbnail_filter_and_video_url`, live).** `get_set_editions`/`get_series_editions`/`get_player_editions`/`get_team_top_editions` now filter `thumbnail_url IS NOT NULL` (Item 5 — the ~7K inert UUID-keyed TS dupe editions stop rendering as "No image" tiles) and expose `e.video_url` (Item 8 source). `get_pack_contents` left unfiltered by design (a pack's real pullable editions must show even if artless). Verified: `get_set_editions(base-set)` → 0 null thumbnails, `video_url` present. Revert: `CREATE OR REPLACE` prior bodies (in this session's transcript).
- **Items 7 + 8 frontend (`29d2e46`).** Branded 1200×630 OG cards: new `/api/og/{edition,set,player,team,series}` routes via shared [lib/og/entity-card.tsx](lib/og/entity-card.tsx) (single-hero for edition/player, 2×2 montage for set/team/series); `lib/seo.ts` `*PageMetadata` helpers now point OG/twitter images at them. All 5 verified live returning `image/png`. Hover-to-play video in `EditionsGridPaginated` (TileMedia) — gated to TS/AllDay, respects `prefers-reduced-motion`, mounts the `<video>` only on first hover.

Note for a future pass: filtering thumbnail-less rows from the grids hides ~715 real-but-artless canonical TS editions from browse grids (still individually reachable via sitemap/direct link/parallels). A genuine TS canonical-thumbnail backfill remains a separate data task.

### May 30, 2026 (evening) — Cowork ops/QA pass: 3 skills + 4 live artifacts, weekly-check query fix, CI/cron handoff

Ops/QA review of every automation (Cowork artifacts, scheduled tasks, GitHub Actions, cron-job.org, edge functions, workers, plugins/skills) plus a 2-week deploy/audit/thread scan. Full write-up: [docs/ops-qa-improvement-review-2026-05-30.md](docs/ops-qa-improvement-review-2026-05-30.md).

Built Cowork-side (sources + installable `.skill` packages in [docs/cowork-skills/](docs/cowork-skills/)):

- **Skills (installed):** `rpc-migration` (DB migration safety checklist — grant resets on CREATE OR REPLACE, security_invoker on public views, CONCURRENTLY rules, verify-rowcount-before-destructive, two collection vocabularies), `rpc-handoff` (Claude Code handoff packager), `rpc-data` (warehouse context — UUIDs, vocab, enum casing, fmv_snapshots partitioning, canonical patterns).
- **Artifacts (live, re-query on open):** `rpc-security-drift` (catalog-SQL security board — RLS-off base tables, anon-write on base tables, `check_secdef_anon_execute_violations`, SECDEF-view count, unused indexes; built because `get_advisors` overflows MCP context), `rpc-pipeline-reliability` (14d per-pipeline fail-rate + connection-pool incident timeline), `rpc-insights-health` (backing-view row counts + FMV/pack-EV freshness per public `/insights` surface).
- **Fixed the `rpc-weekly-health-check` scheduled task:** §7 anon-write query was missing `AND c.relkind IN ('r','p')`, so it false-positived on ~49 public views (verified 0 real base-table holes); also smoke-filtered the §8 concierge count (`is_smoke_test IS NOT TRUE`) and corrected the stale `outbound_clicks` "not wired" note (instrumentation went live 2026-05-30).

Shipped by Claude Code (commit `9172cba`, deploy `dpl_D4zvv2J7WkhAvJLbQLoPvg1D79qn` READY, CI green, smoke 52/0) per [docs/handoff-2026-05-30-ci-cron-cleanups.md](docs/handoff-2026-05-30-ci-cron-cleanups.md):

- **Cadence lint is now a BLOCKING CI gate.** Found the harness was silently broken by the Phase-D reorg — `scripts/extract-cadence.mjs` read the `lib/cadence/purchase-moment.ts` shim (now a re-export with no literal); repointed it to canonical `lib/chains/flow/cadence/purchase-moment.ts` (old shim as fallback). Exits 0 (2 allowed warnings); removed `continue-on-error` in [.github/workflows/ci.yml](.github/workflows/ci.yml). [docs/cadence-testing.md](docs/cadence-testing.md) refreshed (no longer "RED on purpose").
- **Migration `audit_20260530_check_public_security_invariants`** — read-only SECDEF RPC (`check_public_security_invariants()`, RLS-off + anon-write base-table check, `relkind IN ('r','p')`); live result 0 rows. New hard smoke-test assertion in [app/api/smoke-test/route.ts](app/api/smoke-test/route.ts) mirroring the SECDEF-function guard. Revert: `DROP FUNCTION public.check_public_security_invariants();`
- **[docs/operations/cron-schedule.md](docs/operations/cron-schedule.md) reconciled:** `drain-fmv-cold-tail` + `pinnacle-listings-reconcile` moved from Pending additions to Active (both verified live in `pipeline_runs`).

Outstanding (operator-side, cron-job.org, optional/non-breaking): (1) dial `RPC FMV Recalc Force Stale` back from `3,13,23,33,43,53` to `8,28,48` — verified safe 2026-05-30 (first full sweep complete: cursor wrapping ~every 50 min; TS NO_DATA flat ~6,068; HIGH+MED 780); (2) confirm no duplicate `wmc-fmv-populate` cron (no edge function by that name is deployed — keep the Vercel route `/api/wmc-fmv-populate`).

### May 30, 2026 — Cowork full-day pass: FMV recovery, batched RPCs, Step 6 cycle fix, branches, brand pass, research integration

Long Cowork session. Several DB migrations shipped live, one route-code patch shipped via Claude Code (Trevor), CI repaired, dependabot tightened, six live artifacts built, research thread integrated.

Shipped live (5 DB migrations)

- **`audit_20260530_recover_topshot_nodata_with_recent_sales`** — wrote a fresh 1.7.0 snapshot for 146 TS editions that were perpetually NO_DATA despite 30+ recent sales (84 LOW + 62 MEDIUM). TS HIGH+MED 724 → 778 instantly. Chris Youngblood "Rookie Debut" (042c8722, external_id 219:7853): was daily-NO_DATA-restamped since 2026-05-25 23:53; now MEDIUM $8.76 / 30 sales / 4d since.
- **`audit_20260530_recover_topshot_nodata_round2_post_step6_fix`** — round-2 recovery after Item A shipped. The first migration's promotions were re-clobbered by the still-buggy Step 6 in the ~3h window before commit 14ae144 deployed. After Trevor's fix landed, re-running the same logic was durable. Cleared the residual 44-edition tail (active_nodata_5plus = 0).
- **`audit_20260530_upsert_topshot_marketplace_fmv_batched`** — rewrote `upsert_topshot_marketplace_fmv(jsonb)` from a row-by-row PL/pgSQL loop into a 5-step set-oriented transaction. Same signature, same return shape, same grants. Fixes the 113-295s connection pool / statement timeout failures observed 3× in last 14d. Reduces transaction ops from ~4N to ~5 regardless of N. The DELETE additionally swapped `computed_at::DATE = CURRENT_DATE` (non-sargable) for a half-open range that hits `idx_fmv_snapshots_2026_edition_id_timezone_idx` cleanly.
- **`audit_20260530_upsert_allday_marketplace_fmv_batched`** — same shape rewrite for AllDay. Also fixed a latent correctness bug: legacy `SELECT confidence FROM fmv_snapshots ... LIMIT 1` with no `ORDER BY computed_at DESC` was reading an arbitrary partition row, allowing 9 wrongful clobbers on real HIGH/MEDIUM editions in last 7d. New version uses `LATERAL ... ORDER BY computed_at DESC LIMIT 1`.
- **`audit_20260530_upsert_marketplace_fmv_defensive_temp_drops`** — added `DROP TABLE IF EXISTS` before each `CREATE TEMP TABLE ON COMMIT DROP` in both batched RPCs. Production was unaffected (supabase-js `rpc()` is autocommit per call) but smoke testing in one MCP transaction hit "relation already exists." Cheap guard.
- **`audit_20260530_topshot_squeeze_board_view`** — public view ranking TS editions by effective-supply squeeze (lock + burn ≥ 50%), backing the planned `/insights/squeeze` page. Joins `badge_editions` (hourly refresh) + `editions` + latest `fmv_snapshots`. 985 rows. Granted to anon. Sample top: Alex Caruso "2025 NBA Playoffs: Legendary" 156% squeeze (4 of 75 buyable, FMV $765 STALE).

Shipped (code-side via Claude Code — commits on main)

- **Item A: fmv-recalc Step 6 pagination bug (Trevor, `14ae144`).** The WHERE filter (`fs.computed_at < now() - interval '24 hours'`) ran BEFORE the `DISTINCT ON (edition_id) ORDER BY computed_at DESC`, picking the newest pre-24h snapshot per edition. On a mixed-history edition (HIGH this week + NO_DATA last week) Step 6 grabbed the old NO_DATA and re-stamped it forward as "today" — creating a self-perpetuating cycle across cron ticks. Fix: `latest` CTE picks true-latest-per-edition first, then filters `l.computed_at < now() - interval '24 hours' AND l.confidence <> 'NO_DATA'`. Live read-only validation: new query touches 5,550 editions correctly and excludes 5,707 stale NO_DATA rows the old one was re-cycling.
- **CI Node 20 → 24 + lockfile regeneration (Trevor, `2bc776c` + `25ca16a`).** Long-running typecheck red on main was an `npm ci` lockfile drift: package.json had `@types/node@^24` but package-lock.json still pinned `@types/node@20.19.37`. CI was failing with EUSAGE regardless of Node version. Fix: bumped setup-node `node-version: '20'` → `'24'` (matches `engines.node: "24.x"`) and regenerated package-lock.json via `npm install`. Result: CI green (~59s typecheck, 1m3s smoke). Vercel was always READY because Vercel builds on Node 24 by default and resolved the lockfile internally.
- **Dependabot security-only enforcement** (`.github/dependabot.yml`). The previous `allow: dependency-type: "all"` block was a no-op letting routine semver bumps through. Replaced with a wildcard `ignore: [version-update:semver-patch|minor|major]` so only CVE-driven advisories open PRs. Closed 7 stale dependabot PRs (#9-#15) + pruned remote branches.
- **`/api/public/insights/squeeze` route** (`672a41d`). Backs the planned `/insights/squeeze` public page. Reads the new `topshot_squeeze_board` view; supports tier / min_squeeze / max_buyable / set / sort / limit filters. 5-minute `Cache-Control: s-maxage=300` (badge_editions refreshes hourly so 5m is safe). Live smoke against production returned top-5 Legendary squeezes in 334ms.

Research integration

Read both files in `docs/research/` and pulled the live transcript of the running "Flow collection research and strategy" session. Top-line findings carried into platform work:

- Target cohort = 100-2,000 moments held (94 wallets in RPC's tracked population + thousands more not yet seen). Whales already have their own tools.
- Squeeze board = single biggest under-told story on Top Shot. Median lock 38.6%, Wemby RR 81% locked, Origins rookies 60-65% locked. DB-side: shipped `topshot_squeeze_board` view + `/api/public/insights/squeeze` route.
- Cross-collection cohort = 143 wallets hold 3+ Flow collections. RPC's natural intelligence-product community.
- Top Shot packs are absolutely back on chain, inflection week-of 2026-04-13 → 2026-04-20 (1,121 → 14,341 primary pack-week, 12× sustained). NFL All Day flat over same window — this is a TS story, not Dapper-wide.
- Don't promote 200x EV ratios at face value — those are weighted-EV artifacts of one ultra-rare with stale FMV. Rank, not price.
- Don't optimize for own 14k-moment wallet as product — personal artifact OK as build tool.

Six live Cowork artifacts (persistent, re-query on open)

- `rpc-live-health` — 24h pipeline success, FMV per collection, AllDay catch-up bar chart, freshness, alerts, inert-row counter
- `rpc-fmv-watch` — 14-day FMV confidence trend per collection, KPI cards with current HIGH+MED %
- `rpc-my-wallet` — Trevor's portfolio (`0xbd94cade097e50ac`): moments + FMV + confidence breakdown + top holdings + sets + tier + 24h FMV-write changes (silent-clobber detector) + pack history
- `rpc-cross-collection` — the 143-wallet 3+-collection cohort: distribution, top 20 wallets, TS set overlap
- `rpc-trophy-ladder` — Supernova Ultimate ladder + top mint-#1 trophies + 1-of-1 editions, each row showing held-in-RPC count
- `rpc-deploys-and-cost` — Vercel deploys (last 20) + DB size + top 15 tables by size + recent migrations + 7-day pipeline volume

All 6 apply RPC brand standards: RPC Red (`#E03A2F`) accent on KPI values + refresh button + h1 underline, uppercase letter-spaced display treatment on h1/h2/th (Barlow-Condensed-like without external fonts — artifact sandbox doesn't allow Google Fonts), system mono on all numbers + wallets + pills.

Open / deferred

- **TS GQL ingest writer UUID fallback (deferred — inert, sentinel-monitored).** `searchMarketplaceTransactions` returns null for `tx.moment.set.flowId` / `play.flowID`; `searchEditions` returns them populated, so the hydration path can resolve them but `buildEditionKey` has already committed the UUID-pair key by then. ~250 inert UUID rows/6h still accumulating; trigger `editions_block_topshot_uuid_dupe_trg` (BEFORE INSERT OR UPDATE) keeps them inert. Real fix: in `buildEditionKey`, if `extractOnchainIds(tx)` returns null, call `fetchTsEditionMeta(setUUID, playUUID)` and prefer its `setIdOnchain`/`playIdOnchain` over UUID. Full code-side fix in `docs/handoff-2026-05-29-platform-audit.md` Item B.
- **topshot-fmv-populate next cron tick** — still pending verification of the batched RPC under production load. Next expected ~06:00 UTC. Sentinel tripwire (`9c4adb1`) catches any new failures.

Memory entries written (durable across future sessions)

- `fmv-recalc-step6-self-perpetuating-pattern.md` — recognize "stale-touch" sweeps that filter before DISTINCT ON.
- `plpgsql-row-by-row-batch-rewrite-pattern.md` — full template for converting FOR-loop RPCs to set-oriented temp tables, with defensive details.
- `rpc-research-thread-integration.md` — full digest of the Flow collection research thread findings (cohort, surfaces, 4-week plan, what-not-to-do).

Full handoff: `docs/handoff-2026-05-29-platform-audit.md`.

### May 30, 2026 (latest) — fmv-recalc Step 6 self-perpetuating NO_DATA cycle fixed (handoff Item A)

Code-side execution of `docs/handoff-2026-05-29-platform-audit.md` (UPDATED 2026-05-30). The Cowork pass had already shipped the two DB migrations (NO_DATA recovery for 146 editions + batched `upsert_topshot_marketplace_fmv`); this session lands the one route-code fix.

- **Item A — fmv-recalc Step 6 pagination bug (SHIPPED).** [app/api/fmv-recalc/route.ts](app/api/fmv-recalc/route.ts) Step 6 "Stale freshness touch" filtered `WHERE fs.computed_at < now() - interval '24 hours'` **before** the `DISTINCT ON (edition_id) ... ORDER BY computed_at DESC`. Semantics was "pick the newest snapshot that is >24h old" not "pick editions whose latest snapshot is >24h old" — so for a mixed-history edition (HIGH this week, NO_DATA last week) it grabbed the OLD NO_DATA and re-stamped it forward as a fresh NO_DATA. The skipSet only excluded same-tick Step-1 writes, so the cycle was durable across cron ticks. Rewrote the query as a `latest` CTE (true latest-per-edition first) → filter `l.computed_at < now() - interval '24 hours' AND l.confidence <> 'NO_DATA'`. Live read-only validation: new query touches **5,550** editions correctly and excludes **5,707** stale NO_DATA rows the old one would have re-cycled.
  - **Residual:** 44 actively-traded TS editions (5–29 sales/30d) still sit at latest=NO_DATA — below the recovery migration's 30+ threshold. The Step 6 fix stops the *cycle* but does not actively reprice them; they heal as the main cursor sweep (Step 1) reaches them. Not a regression, just an uncovered tail.
- **Item B — TS GQL ingest writer UUID fallback: SHIPPED (`9368ade`).** The full UUID → int-pair redirect path landed in [app/api/ingest/route.ts](app/api/ingest/route.ts) `buildEditionKey`. The 2026-05-30 platform-health pulse still measured `ts_uuid_keyed_48h=2,695` (sentinel WARN level >2,000), but the source has flipped: residual UUID writes now come from `compute-topshot-pack-ev` via `seed_topshot_editions`, not from `/api/ingest`. That secondary leak source is documented as Item B2 in [docs/handoff-2026-05-30-overnight-pass.md](docs/handoff-2026-05-30-overnight-pass.md) — the dedup trigger keeps those rows inert, so it's monitored, not a fire. The 7,112 historical UUID-keyed editions are not safe to bulk-delete (33,291 pack_drop_pool + 16,093 moments + 13,796 fmv_snapshots + 7,089 sales depend on them); resolution requires a canonical-merger like the 2026-05-26 dedup pass.

### May 29, 2026 — Platform-audit handoff: sentinel leak tripwire shipped; Items 1+3 were misdiagnoses

Code-side execution of `docs/handoff-2026-05-29-platform-audit.md`. One of four items needed a code change; the rest were stale or external. **Environment warning: the Git Bash mount served null-corrupted reads of `app/api/**` files this session and tool RESULTS buffered across turns, so several mid-session "confirmations" were false. Commit via PowerShell `git` (bash `git commit` silently no-op'd); re-verify every push with `git rev-list --count origin/main..HEAD` (expect 0); trust the Vercel deploy reaching READY over local reads.**

- **Item 4 — sentinel leak tripwire (SHIPPED `9c4adb1`, deploy `dpl_ADdmBUBHJCNNMnCLRE3MVQYGiSUE` READY, /api/health=200).** `/api/sentinel` now has a `TS Edition Writer Leak (48h)` check counting inert UUID-keyed TS edition rows in the last 48h via `.like("external_id","%-%")` (exact proxy for `!~ '^[0-9]+:[0-9]+$'`). Thresholds `<250` ok / `<2000` warn / else critical. Live value at ship: **5,105**.
- **Item 1 — `topshot-fmv-populate` ok-flag: NO CODE CHANGE (handoff misdiagnosis).** The handoff claimed `ok=false` fires on steady-state `upserted:0` sweeps. False: the deployed code already logs `ok=true` on empty sweeps (proven by `05-27 18:00`, `upserted=0, ok=true`). Every `ok=false` run carries a **real error** — `"Timed out acquiring connection from connection pool"` or `"canceling statement due to statement timeout"`, `duration_ms` 113k–295k. The source flag `ok = rpcError === null && firstGqlError === null` is correct (verified on-disk + `git show HEAD`). These are honest intermittent failures: the final `flush()` → `upsert_topshot_marketplace_fmv` RPC hits Supabase connection-pool/statement timeouts after the GQL loop already exhausted the feed (hence `terminated_reason=feed_exhausted` + populated `error`), ~30% of runs. Real lever = DB connection-pool pressure on that RPC, not a logging change. Closed as not-a-bug.
- **Item 2 — ingest UUID-fallback leak: REAL and ACTIVE, deferred.** `uuid_keyed_48h=5,105` vs `int_keyed=34` confirms it. `buildEditionKey` falls back to the UUID pair when `extractOnchainIds` returns null — i.e. `set.flowId`/`play.flowID` arrive null from `searchMarketplaceTransactions`. The repo query already requests both with correct casing, so root cause is upstream (GQL omitting them) and needs live-GQL probing, not a blind edit. Diagnostic counters were NOT added — the sentinel tripwire (Item 4) already gives the same visibility, and the env read-instability made a hot-path ingest edit too risky this session. Trigger keeps the rows inert (no canonical corruption). **Next session (clean env): add `intPairKeys`/`uuidFallbackKeys` counters in `app/api/ingest/route.ts` (declare inside the `after()` handler near L615 alongside `salesIngested`), surface in a `pipeline_runs` insert, OR probe live TS GQL to confirm the null fields.**
- **Item 3 — `snapshot-institutional-wallets` silent: EXTERNAL, no code change.** The edge function (`supabase/functions/snapshot-institutional-wallets/index.ts`, 505 lines, tracked, `function_version 2`) is already fully resilient (heartbeat-first, `withRetry` on every op, `logRun`/`logExhaustionRun` on every path, `Deno.serve` panic-catch). It ran **6 times, last 2026-05-28 02:47** (31 `wallet_holdings_snapshot` rows) and hasn't fired since. No code makes a cron fire — **Trevor: check/re-enable the cron-job.org entry** (manual trigger: `curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" <fn-url>`). The handoff's "optional try/catch + pipeline_runs write" is already implemented.

### May 28, 2026 (latest, afternoon) — FMV honesty pass: LOW→STALE for stale pricing + AllDay catch-up

Code-side follow-up to the morning's Cowork pass. Two changes to [app/api/fmv-recalc/route.ts](app/api/fmv-recalc/route.ts):

- **Step 5b catch-up:** WHERE predicate changed from `fs.edition_id IS NULL` to a CTE that also matches editions whose latest snapshot's `algo_version NOT LIKE '1.7.%'`. Forces `fmv-recalc` to re-evaluate the 3,369 AllDay editions that have never had a 1.7.0 snapshot (currently stuck on `allday-gql-v1` because `allday-fmv-populate` keeps winning the latest-by-`computed_at` race). Cap is 1000/tick. The downstream delete-then-insert nukes today's snapshot for affected editions so haircut-suffixed variants get replaced.
- **Step 5b LOW→STALE gate:** `confidence: "LOW"` → `confidence: daysSinceSale >= 60 ? "STALE" : "LOW"`. Honesty-ups editions whose only historical sales are 60+ days old — 60 days mirrors the spirit of `apply_fmv_thin_sales_guard`'s stale-30d-no-ask logic; once an edition hasn't traded in 2 months the single-sale WAP is unreliable signal.

Pre-shipped DB migration `audit_20260528_low_to_stale_topshot_zero_90d_sales` flipped 828 TS LOW-zero-90d-sales editions to STALE inline via fresh snapshots tagged `cold-tail-low-recency-1.0` (STALE 1,673 → 2,505). The matching 1,827 AllDay editions are left for Item 4's catch-up sweep to handle — `allday-fmv-populate` would re-clobber any inline STALE write within 30 min.

Order of operations matters: Items 4 + 5 must ship together. Shipping just Item 5 leaves the AllDay 1,827 stuck on `allday-gql-v1` (which doesn't have the new LOW→STALE gate). Items 4 + 5 together cover both populations.

Expected after 24-48h of cron ticks: AllDay HIGH+MEDIUM% rises from 3.7% toward TS's 6.9% baseline, LOW-zero-90d-sales total drops from 2,759 toward <100, STALE total rises from 2,505 toward ~4,500-5,000.

Verification queries:

```sql
-- AllDay editions still on allday-gql-v1 (should trend toward 0 over 1-3 days):
SELECT COUNT(*) FROM (
  SELECT DISTINCT ON (edition_id) algo_version
  FROM fmv_snapshots
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  ORDER BY edition_id, computed_at DESC
) x WHERE algo_version = 'allday-gql-v1';

-- LOW-zero-90d-sales total (should drop toward <100):
SELECT COUNT(*) FROM (
  SELECT DISTINCT ON (edition_id) confidence, days_since_sale
  FROM fmv_snapshots ORDER BY edition_id, computed_at DESC
) x WHERE confidence = 'LOW' AND days_since_sale >= 60;
```

Full handoff: [docs/handoff-2026-05-28-fmv-items-4-5.md](docs/handoff-2026-05-28-fmv-items-4-5.md). Diagnostic basis: `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.

### May 28, 2026 (morning) — Cowork DB session + code follow-ups: TS UUID-dupe writer fix + sentinel RPC swap + stale-fmv-monitor rewrite

DB-side Cowork session shipped 3 migrations live. Code-side follow-ups land in this commit per `docs/handoff-2026-05-28-cowork-pass.md`.

Shipped live (3 DB migrations during Cowork)

- **`audit_20260528_editions_block_topshot_uuid_dupe_cover_update`** — extended the dupe-block trigger from `BEFORE INSERT` to `BEFORE INSERT OR UPDATE`. Root cause discovery: 6,409 new UUID-keyed TS edition dupes accumulated between the 2026-05-26 merge (which got TS to 9,535) and this session. 4,250 (66%) matched the bypass pattern INSERT-with-NULL-onchain-ids → UPDATE-backfills-ids within 1 minute. The trigger gates on `set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL`, so at INSERT time it's FALSE and the row lands; never fires on UPDATE. New trigger nulls the on-chain ids back on UPDATE-match, leaving the row inert. Real fix is the GQL writer — landed in this commit.
- **`audit_20260528_unmapped_sales_retire_archival_flowty_rows`** — retired 49 archival `unmapped_sales` rows where `marketplace='flowty'` (2026-04-17 → 2026-05-13). Flowty marketplace shut down 2026-05-13 and no resolver path operates on `marketplace='flowty'` anymore. Open backlog 60 → 11.
- **`audit_20260528_sentinel_fmv_confidence_rows_rpc`** — new `sentinel_fmv_confidence_rows(p_collection_id uuid)` RPC returning `TABLE(confidence text, count bigint)` based on `DISTINCT ON (edition_id) ORDER BY computed_at DESC`. The existing `sentinel_fmv_confidence` RPC had two bugs: returned a single JSONB object (not the row array the route expects) AND counted all-time `fmv_snapshots` history (324k rows; inflated HIGH to 9,389) instead of latest-per-edition (423). The sister RPC matches the route shape and semantics.

Shipped (code-side follow-ups landing in this commit)

- **GQL editions writer — UUID-dupe root cause fixed** ([app/api/ingest/route.ts](app/api/ingest/route.ts)). The Top Shot ingest GQL query now requests `set.flowId` and `play.flowID` (the on-chain integer ids) alongside the UUIDs. `buildEditionKey` prefers the integer-pair `${set.flowId}:${play.flowID}` (canonical per the 2026-05-26 dedup merge); the previous UUID-pair `${set.id}:${play.id}` is now a defensive fallback only. `upsertEdition` populates `set_id_onchain` / `play_id_onchain` inline so the `editions_block_topshot_uuid_dupe_trg` trigger predicate is satisfied on INSERT. The trigger only fires on UUID-format external_ids (`!~ '^[0-9]+:[0-9]+$'`), so integer-pair writes are completely unaffected — they simply hit the existing integer canonical via `onConflict: "external_id,collection_id"`. Net effect: the ingest path can no longer create UUID-keyed TS edition rows. Verify after deploy: `SELECT COUNT(*) FROM editions WHERE collection_id = '95f28a17-…' AND external_id !~ '^[0-9]+:[0-9]+$' AND created_at >= NOW() - INTERVAL '24 hours'` should drop to ~0.
- **`/api/sentinel` RPC swap** ([app/api/sentinel/route.ts](app/api/sentinel/route.ts)) — one-line change, `sentinel_fmv_confidence` → `sentinel_fmv_confidence_rows`. Fixes the row-shape mismatch that was tripping the `Pipeline Sentinel` GHA workflow on every run.
- **`/api/cron/stale-fmv-monitor` rewrite** ([app/api/cron/stale-fmv-monitor/route.ts](app/api/cron/stale-fmv-monitor/route.ts)) — abandoned the `health_check()` RPC. The current RPC shape no longer carries the route's expected `fmv_pipeline.staleness_minutes` / `sales_pipeline.last_sale_at` / `data_integrity.orphaned_editions_ok` / `database.size_mb` / `database.rls_coverage_pct` fields (the RPC's contract drifted to a flat fmv block + per-collection sales). The route now queries each metric directly in a single `Promise.all` (latest fmv_snapshot, latest sale, edition count, fmv coverage, orphaned-set + orphaned-player counts). Fixes the `RPC Ops Monitor` GHA workflow that was throwing HTTP 500 on every run.

Deferred (Items 3-6 in the handoff)

- **Re-merge the 6,949 TS UUID-keyed dupes** (handoff Item 3) — defer until the writer fix is verified to plateau new dupes at ~0/day. Without the writer fix, the merge would just regenerate the dupes.
- **Items 4-6** (FMV-recalc AllDay throughput, LOW→STALE downgrade, NO_DATA investigation) — documented in `docs/audits/fmv-confidence-decomposition-2026-05-28.md`; touches the complex fmv-recalc path, out of scope for this pass.

FMV diagnostic finding from the Cowork pass: HIGH peaked at 704 on 2026-05-24 then dropped to 423. Looks alarming — actually 203 of the lost editions were on the retired `sales_wap_v1` rogue inflated-AVG algo, so the drop is honest de-inflation. Honest baseline post-clobber-purge is ~501; current 423 is 84% of that. Pinnacle is the FMV quality leader at 53.6% HIGH (vs TS at 2.3% HIGH). Full decomposition in `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.

Edge-function + cron retirement audit confirmed already-clean: all Flowty pipelines stopped 2026-05-24; `topshot-listings-indexer` retired 2026-05-26. Dormant edge functions on Supabase are sleeping idle code, zero ongoing cost.

Full session report: `docs/audits/cowork-platform-pass-2026-05-28.md`. Code-side handoff: `docs/handoff-2026-05-28-cowork-pass.md`. FMV decomposition: `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.

### May 25, 2026 — AllDay unmapped-sales resolver: GQL-primary rewrite + batch_size 5→200

Diagnosed the `unmapped_sales` backlog the prior session's 14:53 smoke test flagged (`{still_unresolved: 2580}`). It is **not** a historical-spork problem — every one of the 2,550 NFL All Day rows is under 6 weeks old. Two compounding bugs were starving the resolver:

1. **Batch starvation.** `app/api/allday-sales-indexer/route.ts` was firing `allday-unmapped-resolver` with `batch_size: 5` (both the "already up to date" branch ~L446 and the normal post-scan branch ~L1043). The edge function is built for 200 (`MAX_BATCH_SIZE=200`, concurrency 16). At 5/run × the indexer's tick cadence, 2,112 of 2,519 unmapped AllDay nft_ids had never even been *attempted*.
2. **Flowty-only edition lookup.** The resolver's primary edition-ID source was Flowty's per-NFT REST. Flowty is a shut-down marketplace; ~60% of AllDay NFT lookups returned `flowty_no_edition_id`, marking the row retired without resolution.

Shipped

- **Edge function rewrite** ([supabase/functions/allday-unmapped-resolver/index.ts](supabase/functions/allday-unmapped-resolver/index.ts)) — deployed live (Supabase project `bxcqstmqfzmuolpuynti`, function v13). Primary edition-ID source is now AllDay's own consumer GraphQL (`searchMomentNFTsV2(byFlowIDs)` → `editionFlowID`, via the `topshot-proxy` `/allday-consumer` route). Flowty's per-NFT REST is kept only as a fallback for ids the consumer GQL doesn't return.
- **Consumer-GQL chunk fix** (edge function v14, deployed live) — `CONSUMER_GQL_CHUNK` dropped from 200 → 40 and `searchMomentNFTsV2(input.first)` from 200 → 40. The consumer `searchMomentNFTsV2` endpoint hard-caps results at 40 edges per page regardless of the `first:` argument, so the original 200-id `byFlowIDs` chunk only ever returned the first 40 — the remaining 80% of every chunk fell through to the Flowty fallback. Chunking at 40 keeps the consumer-GQL primary path doing the work it's meant to.
- **Indexer batch bump** ([app/api/allday-sales-indexer/route.ts](app/api/allday-sales-indexer/route.ts)) — both `fireSupabaseEdgeFunction("allday-unmapped-resolver", …)` call sites changed from `batch_size: 5` to `batch_size: 200`. Expected to drain the ~2.1k untried backlog in roughly a day.
- **`audit_20260525_promote_unmapped_sales_skip_null_price`** + **`audit_20260525_promote_unmapped_sales_skip_nonpositive_price`** — guards `promote_unmapped_sales` against promoting V1-Dapper price-uncertain rows. The first pass added an `IS NOT NULL` check on the assumption that budget-exhausted V1 rows were written with `price_usd=NULL`; the second pass corrected the predicate to `COALESCE(price_usd, 0) > 0` after auditing the actual write path — those rows are stored with `price_usd=0`, not NULL (V1 indexer ~line 976: `price_usd: priceCertain && s.salePrice !== null ? price : 0`). Zero-price rows now wait in `unmapped_sales` until their tx is re-decoded via `/api/admin/recover-v1-budget-exhausted`.
- **`audit_20260525_unretire_allday_resolver_failures_post_consumer_gql`** — un-retired the backlog of `unmapped_sales` rows that were marked retired by the pre-2026-05-25 Flowty-only resolver. With the consumer-GQL primary path now live, the rows that previously returned `flowty_no_edition_id` get a real second chance.
- **`audit_20260525_unretire_allday_resolver_failures_round2_post_chunk_fix`** — second un-retire pass after the v14 chunk fix. The first un-retire ran against v13, which silently dropped 80% of every 200-id chunk on the floor (40-edge page cap); those rows were re-retired by the resolver before the cap was understood. Round 2 reopens them now that v14 actually processes the whole chunk.
- **`audit_20260525_pipeline_alerts_retry_queue_exclude_capped`** — fixed the `retry_queue_stale` check in `get_pipeline_alerts()` to add `retry_count < 10`, so it no longer counts listing-resolution rows that were retried to the cap and retired (1,582 such rows, ~99% Disney Pinnacle, were firing a perpetual false alarm). The alert now means "the retry pipeline is genuinely stuck," not "permanently-unresolvable rows exist."

### May 25, 2026 — Cowork DB session: fmv_from_sales fully retired and dropped

DB-side Cowork session. Two migrations applied live. Completes the fmv_from_sales retirement begun 2026-05-24.

Shipped live (3 DB migrations)

- **`audit_20260525_promote_unmapped_sales_drop_fmv_from_sales_call`** — removed the now-no-op `public.fmv_from_sales()` call from `promote_unmapped_sales`. `fmv_from_sales` was neutralized to a retired no-op on 2026-05-24; `fmv-recalc` '1.7.0' is the sole sales-path FMV owner, so the post-promotion FMV-refresh step was dead weight. Also dropped the `v_fmv_result` local and the always-noise `fmv_refresh` key from the return JSONB — no caller reads it (the 3 sales-indexer routes and the allday backfill/buyer-resolve scripts all discard the return value). Same `(uuid, integer)` signature → grants preserved (`postgres` + `service_role` only). Smoke-tested live: `promote_unmapped_sales(NULL, 50)` → `{promoted:0, still_unresolved:2580, archived:0, duration_ms:1090}`.
- **`audit_20260525_drop_fmv_from_sales_retired_function`** — `DROP FUNCTION public.fmv_from_sales(uuid, integer, text)`. With `promote_unmapped_sales` cleaned up, all 5 historical call sites are clear: the 4 listing-cache routes (allday / golazos / ufc / pinnacle-sync) had the call removed in route code earlier, and `promote_unmapped_sales` was the lone remaining DB-side caller. Verified 0 dependent objects (views, rules, functions) before dropping.
- **`audit_20260525_purge_corrupt_fmv_clobber_residue_with_canonical`** — purged retired-algo FMV clobber residue for 42 editions (151 rows). After the `fmv_from_sales` drop, 301 editions still won on a retired/blocked algo snapshot (`sales_wap_v1%` rogue unfiltered-AVG writer, or `1.1.0%` blocked ingest-clobber writer); 42 had a trusted snapshot underneath (`allday-gql-v1` / `cold-tail-1.0` / `thin-sales-guard-v3` / `1.5.0`, all <30d old), so deleting their corrupt rows restored the trusted price. Verified: 24,782 editions still have a snapshot (0 orphaned); corrupt-winners 301 -> 259. Mirrors the 2026-05-24 clobber purges. The 259 remaining corrupt-ONLY editions (204 `sales_wap_v1`, 55 `1.1.0`) self-heal once fmv-recalc resumes.

After this session `fmv_from_sales` no longer exists in any form. The `algo_version='sales_wap_v1'` rogue-writer path is fully closed — the 2026-05-24 retire-to-no-op + clobber-purge plus this drop mean nothing can write `sales_wap_v1` FMV again. The ~900 `sales_wap_v1`-only editions still self-heal as `fmv-recalc`'s sweep reaches them.

Note — `still_unresolved: 2580` from the smoke test is the recent-AllDay `unmapped_sales` backlog (no edition mapping yet); clearing it is the AllDay resolver work shipped in the 2026-05-25 (latest) session above, not affected by this session.

### May 24, 2026 — Cowork DB session: drain timeout fix, collection-text drift reconcile, fmv_from_sales retired

DB-side Cowork session. Four migrations applied live; route-code follow-up is the commit chain landing this entry.

Shipped live (4 DB migrations)

- **`audit_20260524_drain_cold_tail_candidates_grouped_agg`** — `drain_fmv_cold_tail` candidates CTE rewritten from a per-edition correlated `MAX(computed_at)` subquery to a single `GROUP BY edition_id` aggregate. Same set of rows, dramatically less I/O — fixes the statement-timeout failures on big collections. Provably equivalent: 0 mismatches across the full 24,732-edition population. The function also gets an explicit 120s `statement_timeout` so it can't run wild even on the slow path.
- **`audit_20260524_editions_collection_text_drift_reconcile`** — 307 editions whose denormalised `editions.collection` text disagreed with their authoritative `collection_id` FK were corrected: 299 UFC editions mislabelled `nba_top_shot`, plus 8 NBA stubs mislabelled `disney_pinnacle`. The text column is reader-facing and trustworthy again; the FK was already correct.
- **`audit_20260524_retire_fmv_from_sales_sales_wap_v1`** — `public.fmv_from_sales` neutralized to a no-op (now returns `{retired: true, ...}` and writes nothing). It was a rogue sales-path FMV writer tagged `algo_version='sales_wap_v1'`: an unfiltered `AVG(price_usd)` with an upward `GREATEST()` bias and an unconditional HIGH stamp. It owned **242 of 760** HIGH-confidence editions, with values up to ~759× off the real sales mean. The 4 listing-cache routes that still called it (allday / golazos / ufc / pinnacle-sync) get the call removed in the follow-up commit; the lone remaining DB-side caller is `promote_unmapped_sales`, which is a separate task.
- **`audit_20260524_purge_sales_wap_v1_clobber_with_canonical`** — deleted the `sales_wap_v1` clobber rows for 225 editions that already had a canonical `1.7.0` snapshot underneath, restoring them to honest pricing immediately. The remaining ~900 `sales_wap_v1`-only editions self-heal as `fmv-recalc`'s sweep reaches them.

After this session, `fmv-recalc` '1.7.0' is the sole sales-path FMV owner. Combined with the existing `algo_version LIKE '1.1.0%'` ingest guard, the latest-`computed_at`-wins resolution can no longer be hijacked by an unfiltered-AVG writer.

### May 24, 2026 — Cowork autonomous platform pass: FMV clobber residue + pack EV unpoison + verification sweep

Autonomous Cowork session. Full write-up: [docs/audits/cowork-platform-pass-2026-05-24.md](docs/audits/cowork-platform-pass-2026-05-24.md). Code-side follow-ups: [docs/handoff-2026-05-24.md](docs/handoff-2026-05-24.md).

Shipped live (3 DB migrations)

- **FMV `1.1.0` clobber residue purged** — the earlier `audit_20260524_block_stale_ingest_fmv_algo` trigger blocked *new* `1.1.0` inserts but 613 editions were still *winning* on stale `1.1.0`/`1.1.0_haircut` snapshots (the trigger matched exact `'1.1.0'` only, not the `_haircut` variant). Migration `audit_20260524_block_stale_ingest_fmv_algo_haircut` extends the guard to `algo_version LIKE '1.1.0%'`; `audit_20260524_purge_fmv_1_1_0_clobber_residue` deleted 15,922 clobber rows and restored 549 editions to their canonical snapshot (64 editions with only a `1.1.0*` row left intact to avoid orphaning).
- **Pack EV queue poison — actually fixed.** The v17 edge-function "sentinel" fix did not work: sentinels are written with `pack_price = 0`, but `pack_ev_latest` filters `WHERE pack_price > 0`, so they never reached the targets view — 1,105 of 1,114 TS packs stayed >7d stale. Migration `audit_20260524_pack_ev_targets_unpoison_via_history` points `topshot_pack_ev_targets.last_ev_at` at `max(snapshotted_at)` from `pack_ev_history` directly. Queue drains now (~2 days, self-healing).
- **`migrate-wmc-edition-keys`** set `is_active=false` in `pipeline_cadence_watchlist` (cron + route already retired; the watchlist entry would have false-alarmed at the 24h-silence mark).

Verified clean / premise outdated

- wmc `edition_key` corruption — 0 corrupt rows; the 2026-05-24 repair held; `wmc_edition_key_drain_v3` fully dropped.
- FMV STALE spike (597→1,739) is **not a regression** — `cold-tail-stale-repair-1.0` converted ~1,006 `NO_DATA` editions to STALE (an upgrade); 96.5% of STALE editions haven't traded in 30d.
- **Pinnacle FMV works** (corrects known-issue #4) — `pinnacle_fmv_snapshots` has 425 editions, 84% HIGH+MEDIUM, recomputed daily by `pinnacle-1.0.0`.
- Pipeline failures are all transient connection-pool/lock contention — no logic bugs. The 17 anon-SECDEF functions are all intentional public-page/concierge RPCs — no May-3-revoke regression.

Key finding — the FMV HIGH-confidence lever is throughput. `fmv-recalc` has priced only 5,105 editions ever vs 9,273 traded in 30d; it is ~13% through its first full sweep of 262,733 sales (~9 days to finish). Accelerating it (`DEFAULT_LIMIT` raised 1k→2.5k on 2026-05-24, commit `43c8d9c`; recent-edition-first chunking + faster cron still to do) is the single biggest FMV-quality win.

### May 24, 2026 — Platform audit: FMV / Pack EV / badges + FMV-ingest clobber fix + Flowty teardown finish

Shipped (round 2 — 2026-05-24)

- **wmc edition_key drain pipeline RETIRED** — `/api/admin/migrate-wmc-edition-keys`, `scripts/cleanup-wmc-int-orphans.mjs`, and the cron-job.org entry all deleted. The drain (RPC `wmc_edition_key_drain_v3`, plus `wmc_dedup_pairs` / `wmc_dedup_pairs_sync_from_view` / `editions_canonical_pair` plumbing) was corrupting `wallet_moments_cache.edition_key` — it rewrote valid `set:play` keys to `editions.id` UUIDs, breaking every reader that joins on `editions.external_id = wmc.edition_key`. The v3 SQL function was neutralized to a no-op in the DB and ~200k corrupted rows were repaired. **Invariant going forward: `wmc.edition_key` must always equal `editions.external_id` — never `editions.id`.** Full post-mortem: [docs/audits/wmc-edition-key-corruption-2026-05-24.md](docs/audits/wmc-edition-key-corruption-2026-05-24.md).
- **FMV ingest-clobber root cause** ([app/api/ingest/route.ts](app/api/ingest/route.ts)) — deleted `upsertFmvSnapshot`. It was a crude per-sale median+raw-count writer tagged `algo_version="1.1.0"` that ran on EVERY ingested sale, plus a "proactive" pass over every integer-format edition without an FMV row. Because `fmv_snapshots` resolves "latest `computed_at` wins", that fresh-but-crude row clobbered the canonical [lib/fmv-confidence.ts](lib/fmv-confidence.ts)-driven `fmv-recalc` "1.7.0" snapshot every time an edition traded — confirmed by snapshot history showing ~1,400 actively-traded TS editions flipping 1.7.0 → 1.1.0 daily. Ingest now writes sales only; `fmv-recalc` is the sole FMV owner on the sales path (its Step 5b historical-sales fallback covers new editions within a sweep cycle). Backed by DB migration `audit_20260524_block_stale_ingest_fmv_algo` (BEFORE INSERT trigger `fmv_snapshots_block_stale_ingest_algo_trg` that drops any `algo_version='1.1.0'` insert defensively — stays in place as a permanent guard).
- **Flowty teardown — entangled code paths + Phase 3 reframe** (per [docs/audits/flowty-teardown-plan-2026-05.md](docs/audits/flowty-teardown-plan-2026-05.md)):
  - [app/api/sniper-feed/route.ts](app/api/sniper-feed/route.ts) — Flowty leg of `computeSniperFeed` deleted: `fetchAllFlowtyListings`, `fetchFlowtyPage`, the Flowty-trait helpers (`flattenTraits`, `getTraitMulti`, `FLOWTY_TRAIT_MAP`), the LiveToken FMV branch, Flowty enrichment from `badge_editions`, the sub-$1 "cross-listed Flowty" re-tagging, the `fetchOpenOffers` join, and the `cached_listings` end-of-pipeline fallback. The route is Top Shot GQL only now; `marketplaceAvailability.flowty` hardcoded `false`. The `computeCachedSniperFeed` path (golazos/ufc) was deleted with it — it read the dead `cached_listings` table; those collections now return empty rather than serve frozen rows. Filter-exhaustion page-count loop also removed (it only ever deepened the Flowty fetch).
  - [app/api/moment-market/route.ts](app/api/moment-market/route.ts) — `getFlowtyQuotes` web-prerender scrape branch deleted; response is Top Shot quotes only, with `flowtyAsk: null`, `flowtyListingUrl: null`.
  - [app/api/listing-cache/route.ts](app/api/listing-cache/route.ts) — `backfillAskProxyFmv` (which wrote `fmv_snapshots` rows tagged `algo_version="v1.5.1_ask_proxy"` from `cached_listings.ask_price` × 0.9) and `runAskOnlyFmv` (which called the `fmv_from_cached_listings` RPC tagged `"v1.0_ask_only"`) both deleted. The Flowty fetch + `cached_listings` upsert remains as the read-only ingest contract but is gated off by `isFlowtyIngestEnabled()`.
  - [app/admin/flowty-analytics/page.tsx](app/admin/flowty-analytics/page.tsx) — relabelled "Historical Archive". File header, sign-in screen, and dashboard header now state "Flowty closed May 2026" explicitly and explain the data is a frozen archive.
  - Teardown doc updated — Phase 2 (entangled-paths pass) and Phase 3 (reframe) both marked DONE; Phase 2's stale "NEXT" framing replaced with a Shipped + Punted breakdown.

Shipped (round 1 — earlier 2026-05-24)

- **FMV recalc de-Flowty + invalid-enum fix** ([app/api/fmv-recalc/route.ts](app/api/fmv-recalc/route.ts)) — deleted Step 2b (Flowty LiveToken FMV blend reading `cached_listings.source='flowty'`) and Step 2c (floor-ask proxy reading `cached_listings.ask_price`). `cached_listings` now holds ~24 frozen multi-week-stale rows since the Flowty shutdown; both inputs were dead. Also retired the ask-proxy branch that wrote `confidence = "LOW_ASK_PROXY"` — that value is not in the `fmv_confidence` enum (`HIGH | MEDIUM | LOW | ASK_ONLY | SALES_ONLY | STALE | NO_DATA`), and snapshot inserts chunk 100 rows at a time, so a single LOW_ASK_PROXY row failed the whole chunk and silently dropped ~99 good snapshots. FMV is now purely sales-based (outlier-filtered WAP → trimmed-median fallback).
- **`/api/badges` play_tag filter** ([app/api/badges/route.ts](app/api/badges/route.ts)) — Top Shot's `play_tags` array mixes ~6 real moment badges with ~25 gameplay descriptors (Jump Shot, Dunk, Block, Steal, Tomahawk Dunk, …). The unified-badges map emitted EVERY tag, so every TS moment showed gameplay tags as badges. Now allowlists `play_tags` to the 9 real badge titles (topshotdebut, rookieyear, rookiemint, rookiepremiere, mvpyear, championshipyear, rookieoftheyear, allstar, threestarrookie) via lowercased + alphanumeric-only normalization. `set_play_tags` stays unfiltered — all real badges.
- **DB-side counterparts deployed before this session:**
  - migration `audit_20260524_badge_unified_filter_play_tags` — `get_edition_badges_unified` applies the same play_tag allowlist server-side.
  - migration `audit_20260524_edition_detail_badges_from_unified` — `get_edition_detail` derives the `badges` field from `get_edition_badges_unified` instead of the always-empty `editions.badges` column (0/24,705 populated).
  - edge function `compute-topshot-pack-ev` redeployed as v17 — un-resolvable packs (no editions from TS API, no dynamic data, fully depleted) now write a sentinel `pack_ev_history` row so `last_ev_at` advances. Fixes the queue-poison that left ~1,105 of 1,113 Top Shot packs with EV >7 days stale.
- **Moment / Pack / Set page audit follow-ups** (per "Known issues" item 17 punch list):
  - Moment modal a11y ([components/MomentDetailModal.tsx](components/MomentDetailModal.tsx)) — `role="dialog"`, `aria-modal`, labelled close button, focus trap (escape + shift-tab wrap), restore-focus-on-close, `aria-hidden` decorative hover video.
  - Set modal a11y ([app/(collections)/[collection]/sets/page.tsx](app/(collections)/[collection]/sets/page.tsx)) — same `role="dialog"` / `aria-modal` / focus-trap treatment; `ModalRow` thumbnails now use the player name as `alt` instead of empty.
  - Set audit B2 ([app/api/sets/route.ts](app/api/sets/route.ts)) — `lowestSingleAsk` now an explicit `Math.min` across the missing array instead of trusting `missing[0]` to be cheapest.
  - Set audit B3 ([app/(collections)/[collection]/sets/page.tsx](app/(collections)/[collection]/sets/page.tsx)) — `SetCard` expand and the modal-open effect now share an in-memory `Map<wallet:setId, SetProgress>` cache via `fetchSetDetail()`; the modal effect depends on `openSet?.setId` (not the whole object) so it doesn't re-fire on re-renders.
  - Set audit B6 ([app/api/sets-db/route.ts](app/api/sets-db/route.ts)) — Golazos incomplete sets now classify by completion-pct (`complete` / `almost_there` / `incomplete` / `unpriced`) instead of labelling every <100% set "unpriced".
  - Moment audit B7 ([app/moment/[id]/page.tsx](app/moment/[id]/page.tsx)) — JSON-LD `offers.availability` now reflects real listing state (`is_listed=true && list_price > 0`, or `top_shot_ask > 0`) → `InStock` / `OutOfStock`; FMV alone is no longer treated as a live listing.
  - Moment audit B9 ([app/moment/[id]/page.tsx](app/moment/[id]/page.tsx)) — owner address renders as a truncated `/profile/<addr>` link via a local `OwnerLink` helper; `StatCell` widened to accept `ReactNode`.
  - Pack audit B1 ([app/(collections)/[collection]/packs/simulator/[distId]/page.tsx](app/(collections)/[collection]/packs/simulator/[distId]/page.tsx)) — deleted the dead `/api/pack-ev` `{distId}` fetch (route requires `packListingId` and emits no `momentsPerPack` field, so it returned 400 and silently fell to 5-slot anyway for 100% of NFL/UFC/Pinnacle/Golazos packs). Goes straight to the 5-slot approximation when `pack.slots == null`.
  - Pack audit B2 ([app/(collections)/[collection]/pack/dist/[distId]/page.tsx](app/(collections)/[collection]/pack/dist/[distId]/page.tsx)) — Top-Pulls probability denominator was the sum of the top-50 `drop_weight` rows (the pool query is `.limit(50)`), inflating every displayed Drop %. Added a parallel full-pool `SUM(drop_weight)` query; denom is now `total_unopened` if present, else full-pool weight, else null (no more partial-pool fallback).
  - Pack audit B3 ([app/(collections)/[collection]/packs/simulator/[distId]/page.tsx](app/(collections)/[collection]/packs/simulator/[distId]/page.tsx)) — simulator now tracks `fmvCoveredSlots` and surfaces an honest "X / Y pulls had FMV (Z%). Slots without FMV are counted as $0, so values above are a lower bound." caption when coverage <99.5%.
- *Punted, with reasons:* Set S2 (Flowty floor staleness guard — underlying input was the now-removed Step 2b/2c FMV-recalc blend, and the set detail page already shows "Updated {relTime}"). Set S4 (audit which collections still emit `ASK_ONLY` post-Flowty — research, not a code change; the AllDay GQL pipeline `allday-gql-v1` legitimately emits ASK_ONLY from `lowestPrice` and is independent of Flowty).

### May 23, 2026 — Market/Sniper reframe to outbound links

Prioritized Next Action #1 — the "stop looking broken" change. Market and Sniper are reframed from a (now-dead) live-buy surface into FMV + discount intelligence with outbound listing links.

Shipped (commit `b19d8f2`, deployed)

- **Sniper** ([app/(collections)/[collection]/sniper/page.tsx](app/(collections)/[collection]/sniper/page.tsx)) — removed the whole in-app buy flow: the DEALS/OFFERS tab + `OffersTab`, the `+ CART` / `+ OFFER` buttons, OFFER MODE + duration, and the `useCart`-based `ActionCell`. Every CTA (desktop row, mobile card, edition-depth panel, relative-deals table, moment modal) is now a single outbound **`View Listing →`** link via a new `resolveViewUrl()` helper — prefers the deal's native marketplace URL, falls back to the native moment page when the stored URL is a dead Flowty link.
- **Killed every "looking broken" banner** across sniper / market / Pinnacle sniper — top `MarketplaceStatusBanner`, the red TS/FLOWTY **OFFLINE** header chips, the "LIVE FEEDS OFFLINE — cached" banner, `FlowtyDormancyChip`, the "FLOWTY OFFLINE" card, and the Pinnacle info banner.
- **Market** ([app/(collections)/[collection]/market/page.tsx](app/(collections)/[collection]/market/page.tsx)) — removed the status banner + dormancy chip + `useMarketplaceStatus` hook; `Buy` / `UNAVAILABLE` pill → outbound `View Listing →` via `resolveListingUrl()`. Kept the thin-volume analytics caveat (honest data-confidence copy, not a broken-state banner).
- **Pinnacle static sniper** ([app/(collections)/disney-pinnacle/sniper/page.tsx](app/(collections)/disney-pinnacle/sniper/page.tsx)) — removed the "FLOWTY OFFLINE" chip + Pinnacle info banner; "SCANNING FLOWTY MARKETPLACE" → "SCANNING THE PINNACLE MARKETPLACE"; action button → outbound per-pin `View Listing →`.
- Net: 565 lines of cart/offer/banner code removed across 3 files. Discount-vs-FMV deal scoring, confidence dots, serial badges, filters, and ownership tracking all kept.

Note — `disney-pinnacle/sniper/page.tsx` is a static route that shadows the `[collection]` dynamic sniper for Pinnacle; both were reframed.

### May 23, 2026 — Cowork platform health audit + FMV confidence overhaul

Platform health + cron audit, then an FMV-confidence improvement pass.

Shipped

- **listing-divergence-snapshot Flowty-offline guard** ([app/api/listing-divergence-snapshot/route.ts](app/api/listing-divergence-snapshot/route.ts)) — was failing ~80% of runs (75-135s `compute_listing_divergence` scans timing out) because Flowty is dead (8 stale listings vs 34k direct). Added a pre-check: open Flowty listings for the collection < `FLOWTY_OFFLINE_THRESHOLD` (50) → skip the heavy RPC, log `ok=true` + `skip_reason='flowty_offline'`. Self-healing.
- **FMV serial-residual confidence gate** ([lib/fmv-confidence.ts](lib/fmv-confidence.ts)) — the HIGH gate (CV<0.40) ran on raw sale prices, so legitimate serial-driven spread (#1 vs #25000 of a moment) read as noise and capped HIGH at ~2%. `escalateConfidence` now takes an optional `serials` array and gates HIGH on the residual of a per-edition `ln(price)~ln(serial)` OLS fit (`serialResidualDispersion`), falling back to raw CV when serials absent. `fmv-recalc` + `fmv-backfill` select + pass `sales.serial_number`. Modelled HIGH-eligible ~900 → ~1,260.
- **FMV recalc pagination fix** ([app/api/fmv-recalc/route.ts](app/api/fmv-recalc/route.ts)) — the route paginates its sales scan by `{offset,limit}` but cron/chains always called it with no offset → it reprocessed page 0 forever (~41 editions). Now resumes from the previous run's `cursor_after` in `pipeline_runs`, wraps to 0 at table end (empty-page guard logs `sweep_wrapped`). `DEFAULT_LIMIT` 500→1000, `export const maxDuration = 300`. Full sweep ≈ 4-5 days at the observed ~12-16 recalc triggers/day.
- **drain_fmv_cold_tail ASK_ONLY fallback** (migration `audit_20260523_drain_cold_tail_ask_only_fallback`) — the RPC wrote `NO_DATA` for every zero-sale edition; now checks `cached_listings_v2` for a live ask and writes `ASK_ONLY` when one exists.
- Live Cowork health dashboard artifact built; `docs/cadence-testing.md` "RED on purpose" claim corrected (harness is GREEN since the C1/C2 fix).

Key findings — the FMV pipeline is fragmented

- `fmv_snapshots.algo_version` is written by ≥5 distinct pipelines and "latest by `computed_at`" wins: `1.7.0` (fmv-recalc), `allday-gql-v1` (allday-fmv-populate, AllDay marketplace GQL), `cold-tail-1.0` (drain-fmv-cold-tail), `sales_wap_v1`, `thin-sales-guard-v3`, plus obsolete `1.1.0`/`1.5.0`. Only `fmv-recalc`/`fmv-backfill` use the shared `lib/fmv-confidence.ts`.
- `allday-gql-v1` already does ask-based pricing (`averageSale` → LOW, `lowestPrice` → ASK_ONLY, ≤$5000 ceiling). AllDay is essentially fully priced — only 531 AllDay editions are genuinely `NO_DATA`.
- The ~10.8k Top Shot `NO_DATA` editions are structurally unpriceable: cohort/comparable pricing was modelled and rejected (set+tier cohorts too dispersed; player+tier cohorts have no coverage). The real FMV lever now is *primary data* — a live Top Shot listings feed — not more inference.

Docs added: `docs/audits/fmv-confidence-improvement-2026-05.md`, `docs/audits/flowty-teardown-plan-2026-05.md`.

### May 18, 2026 — V1 Dapper NFTStorefront indexer refactor

Discovered via Flowscan trace of a $2,999 JJLSmith Mahomes Marquee Ultimate purchase (NFT id 9430364, edition 4097, wallet `0xc579f9caeac49f95`) that AllDay / Golazos / UFC native sales route through **V1 Dapper NFTStorefront** at `A.4eb8a10cb9f87357.NFTStorefront` (no V2 suffix). The V2 Dapper storefront at the same address (`A.4eb8a10cb9f87357.NFTStorefrontV2`) only carries TopShot PackNFT / Pinnacle / MFL packs; the V2 Flowty fork at `0x3cdbb3d569211ff3` has been dormant since 2026-05-14. Our DB confirmed the blind spot was lifetime-wide — 153 AllDay-holding wallets had never been seen as buyer in `sales`, and the JJLSmith wallet held 105 AllDay moments with zero `moment_acquisitions` rows.

Shipped

- **New helper** [lib/dapper-v1-tx-decode.ts](lib/dapper-v1-tx-decode.ts) — fetches `/v1/transaction_results/{txId}` and parses three auxiliary events per V1 sale:
  - `<collection>.Deposit (.to)` → buyer
  - `<collection>.Withdraw (.from)` → seller
  - `DapperUtilityCoin.TokensWithdrawn` where `from = 0xead892083b3e2c6c` → gross sale price
  - Sanity check: split-sum (TokensWithdrawn from non-contract sources) must equal gross within 1¢; mismatch flags the tx as price-uncertain so it routes to `unmapped_sales` instead of recording a guessed price. Sample DUC amounts captured in `resolution_hint` for offline investigation.

- **Sales indexers** (allday / golazos / ufc) — single cursor scans BOTH `A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted` (V1 primary) AND `A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted` (V2 legacy) per tick. V1 sales follow: cached_listings_v2 lookup by listing_resource_id → `decodeV1SaleTx` fallback → `unmapped_sales` for uncertain price. V1 rows write `marketplace='nflallday'|'laligagolazos'|'ufcstrike'` + `source='onchain_dapper_v1'`; V2 rows keep existing `marketplace='flowty'` + `source='onchain'` semantics.

- **Listings indexers** (allday / golazos / ufc) — single cursor scans all FOUR event types per tick (V1 ListingAvailable + V1 ListingCompleted + V2 ListingAvailable + V2 ListingCompleted). V1 ListingAvailable payload carries `price (UFix64)` + `ftVaultType (Type)` inline — no aux fetch needed. V1 rows land in `cached_listings_v2` with `source='direct_v1'`; V2 chain rows keep `source='direct'`. Cancellation marking is source-scoped per version.

- **nftType filter precision** — switched from `.includes("AllDay")` to `.endsWith(".AllDay.NFT")` (and `.endsWith(".Golazos.NFT")` / `.endsWith(".UFC_NFT.NFT")`) to prevent false matches against hypothetical sibling contracts at the same address.

Key constants (May 18)

- V1 Dapper NFTStorefront: `A.4eb8a10cb9f87357.NFTStorefront` — native marketplace for AllDay/Golazos/UFC.
- V2 Flowty fork: `A.3cdbb3d569211ff3.NFTStorefrontV2` — dormant since 2026-05-14, kept for cancellation tail.
- V2 Dapper storefront: `A.4eb8a10cb9f87357.NFTStorefrontV2` — carries TopShot PackNFT / Pinnacle / MFL packs only.
- DUC contract: `0xead892083b3e2c6c`. Gross sale price = sum of `TokensWithdrawn` where `from == DUC_contract`.
- New `sales.source` value: `onchain_dapper_v1` (distinct from existing `onchain` for V2 fork).
- New `cached_listings_v2.source` value: `direct_v1` (distinct from existing `direct` for V2 chain ingestion).
- `unmapped_sales.resolution_hint` for V1 price-uncertain: `{ nft_id, sale_source: 'v1_dapper', price_extraction: 'no_duc_from_contract' | 'split_sum_mismatch' | 'tx_fetch_failed' | 'tx_no_events' | 'v1_tx_decode_budget_exhausted', sample_duc_amounts: [...] }`.
- V1 tx-decode budget per tick: 25 calls (independent from Cadence borrow budget). Cache-hit path: 1 REST per sale for buyer (cached_listings_v2 doesn't store buyer_address). Cache-miss: 1 REST per sale for full decode.

Verification: monitor `pipeline_runs.extra` within 30 minutes of deploy for `v1_filtered_in > 0`. Pre-deploy this was always 0 (V2 fork dormant); post-deploy expect ~5-25/tick across all three sales indexers. The `v1_uncertain_sample` array in extras surfaces price-extraction failure patterns to investigate.

### May 8, 2026 — Account linking + site lockdown hardening + paginated wallet recovery

Shipped

- **Account linking infrastructure** — Phase 1 of cross-collection canonical-owner resolution. New table `linked_accounts(parent_addr text, child_addr text)` with composite PK on the pair. Currently holds 6 active links. Three reader RPCs:
  - `get_linked_parents(child_addr)` — returns parents of a child account
  - `get_linked_children(parent_addr)` — returns children of a parent account
  - `get_linked_all(addr)` — returns the full link graph for an address (parents + children, transitive)
  - `resolve_canonical_owner(addr)` — collapses a child address to its canonical parent for analytics. Returns the input addr if no parent exists.
  - New view `analytics_sales_resolved` re-projects `analytics_sales` through `resolve_canonical_owner` so leaderboards and Top Buyers/Sellers RPCs deduplicate parent + child wallets that belong to the same collector.
  - New worker `hybrid-custody-proxy.tdillonbond.workers.dev` fronts HybridCustody event reads against contract `0xd8a7e05a7ac670c0`. Same `X-Proxy-Secret = TS_PROXY_SECRET` shared rotation surface.
  - New `hybrid_custody_events` ingest pipeline runs every 20min via cron-job.org. Indexes child-account-publish + revoke events; writes derived state into `linked_accounts`.

- **Wallet-backfill paginated recovery** — fixes mega-wallet failures previously logged as `computation_limit_exceeded`:
  - New `?force=true` query parameter on all wallet-backfill routes bypasses `skip_cached` semantics. URL-friendly equivalent of `body.skip_cached=false` for cron triggers and ad-hoc curls.
  - New `runPaginatedDetailsBackfill` helper in `lib/wallet-backfill-helpers.ts` chains `GET_<collection>_DETAILS_RANGE(addr, start, count)` Cadence scripts in chunks. CHUNK_SIZE constants: `allday: 1000`, `pinnacle: 500`. Both UFC and TS already had bounded scripts, so they reuse the same pattern.
  - Catches both `computation_limit_exceeded` (Cadence 1110, in-execution) and `access_api_error_likely_computation_limit` (the same condition surfaced through the Flow access node) and continues the next chunk instead of bailing.
  - `maxDuration` bumped to 600 across the four backfill routes to absorb pagination wall-clock.
  - **Pre-flight short-circuit**: before walking chunks, load `Map<moment_id, edition_key_present>` from wmc; if every on-chain ID is already cached AND has `edition_key` populated, skip pagination entirely with `terminated_reason='all_ids_already_enriched'`. Only applies when `skipCached=true && force=false`. Force-mode preserves full re-walk semantics. Post-pass JOIN UPDATE still runs because `pinnacle_editions` / `editions` may have new metadata since the prior cron tick.

- **Site lockdown `proxy.ts` hardened** (commit `2e3be0f`):
  - Auth check order: Bearer `INGEST_SECRET_TOKEN` and `CRON_SECRET` validated FIRST (also accepts `?token=` query param for browser-fired cron triggers). Anything that authenticates as a server caller skips the rest of the chain.
  - Public path bypass (no auth required): `/login`, `/early-access`, `/auth`, `/api/auth`, `/api/early-access`, `/api/admin`, `/api/cron`, `/api/public`, `/api/wallet-search`, `/api/support-chat`, `/api/cart`, `/api/health`, `/admin`, static assets.
  - `/` (root home) is NOT in the public list — must be authed. This is the breaking change vs. the May 6 cut.
  - Unauthed access → 302 to `/login?next=<encoded original path>`.
  - Allowlist check: 60s `rpc_al_check` cookie keyed by email hash → `check_email_allowed` RPC. Cookie miss triggers a fresh RPC; cookie hit short-circuits to allow.
  - `check_email_allowed` returning `false` → server-side `signOut()` + redirect to `/login?error=access_revoked`.
  - `check_email_allowed` RPC fault → fail-closed redirect to `/login?error=allowlist_unavailable`. Do NOT let traffic through on RPC fail.
  - `allow_list.status = 'active'` is the only valid state for access; `paused`, `revoked`, `pending` all reject.
  - Sign-in page lives at `/login` (not `/auth/login`).
  - Banner copy on `/login?error=*` pages links `@tdillonbond` for support contact.

Key constants (May 8 latest)

- `linked_accounts` PK: `(parent_addr, child_addr)`, both `text NOT NULL` storing 0x16-hex Flow addresses.
- HybridCustody contract: `0xd8a7e05a7ac670c0`. Worker: `hybrid-custody-proxy.tdillonbond.workers.dev`.
- AllDay-unmapped-resolver runs every 20min **by design, chained from sales-indexer** — it does NOT have its own cron entry. Drains ~3.9 edition_key mappings per tick. There is a permanent residual of ~30 NFTs that return `flowty_no_edition_id` from upstream and never resolve; the May 8 (late) `tighten_unmapped_resolver_retire_threshold` migration drops the permanent-retire threshold from `retry_count >= 10` to `retry_count >= 5` to cull these faster.
- UFC Strike status: PUBLISHED + BETA. Coverage: 147 editions / 247 wmc rows. `UNIQUE(wallet_address, collection_id, moment_id)` enforced. Tier vocabulary: `CHALLENGER / CONTENDER / FANDOM`.
- `runPaginatedDetailsBackfill` `terminated_reason` values: `no_more_moments` (success, walked to end), `all_ids_already_enriched` (success, pre-flight short-circuit), `computation_limit_exceeded` (Cadence 1110 from chunk script), `access_api_error_likely_computation_limit` (Flow access-node surface of the same), `storage_limit_exceeded` (Cadence 1106), `no_collection_capability`, `error` (catchall).
- Cloudflare Workers (current, all `.tdillonbond.workers.dev`): `topshot-proxy`, `pinnacle-proxy`, `spork-proxy`, `allday-proxy`, `rpc-sports-proxy`, `odds-proxy`, `reddit-proxy`, `hybrid-custody-proxy`.

#### Worker auth surfaces (3 rotation domains)

The "all workers share `TS_PROXY_SECRET`" framing was an oversimplification — there are three independent rotation surfaces. Audit 2026-05-10 confirmed: rpc-sports-proxy was drift (fixed); reddit-proxy phantom secret was deleted; odds-proxy auth gate added with both `PROXY_SECRET` and `ODDS_API_KEY` now present.

(a) **`TS_PROXY_SECRET` via `X-Proxy-Secret` header** — `topshot-proxy`, `allday-proxy`, `pinnacle-proxy`, `reddit-proxy`, `rpc-sports-proxy`, `odds-proxy`. Rotate via `wrangler secret put PROXY_SECRET --name <worker>` for each, plus the matching Vercel env var.

(b) **`INGEST_SECRET_TOKEN` via `Authorization: Bearer` header** — `hybrid-custody-proxy` and Vercel ingest routes. Rotate together; do NOT assume the X-Proxy-Secret rotation covers this.

(c) **`SPORK_PROXY_SECRET`** — `spork-proxy` only (historical block-height reads on port 8070). Rotate independently.

Never assume rotating one surface covers another.

---

### Older sessions

Archived to `docs/sessions/`:

- `docs/sessions/2026-05.md` — May 8 (late) TS edition seed + resolver tune, May 8 Pinnacle backfill chain, May 7 multi-collection close-out, May 6 ×4 (multi-collection prep, sync-nba-odds, wallet truncation fix, DraftKings retirement), May 2 (schema drift / proxy auth / search_path).
- `docs/sessions/2026-04.md` — April 26 (Flowty failed-tx monitor), April 21 ×2 (Storefront Audit Pipeline, Phase 4 multi-collection concierge), April 10 (on-chain sales indexer).

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

The `[collection]` dynamic segment serves all 5 published collections: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike. Common tabs across collections: `overview`, `collection`, `sniper`. Top Shot additionally has `packs`, `badges`, `sets`, `market`. Pinnacle does not have `sets`. Top Shot also has Fast Break and RTR (Road to the Ring) game features.

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
- RLS check: `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false`. Currently 0 rows — RLS on all 88 public tables.
- `health_check()` RPC function is the single source of truth for platform state.
- `pipeline_runs` uses `pipeline` text column (not `function_name`) and `ok` boolean (not `status` text); `extra` is JSONB — use `extra->>'key'` for text extraction.
- Supabase MCP multi-statement queries return only last result — use single statements per call.
- PostgREST caps at 1000 rows — use `.limit(10000)` or RPCs for larger reads.
- `players` + `sets`: composite `UNIQUE(external_id, collection_id)`.
- `execute_sql(query text) RETURNS void`, SECDEF, service_role only.
- `tier_type` enum: `COMMON / FANDOM / RARE / LEGENDARY / ULTIMATE`. UFC Strike uses its own vocabulary: `CHALLENGER / CONTENDER / FANDOM`.

### Security posture (May 3 audit)

0 security ERRORs. SECDEF anon-revoke complete — 10 previously anon-callable fns now `postgres + service_role` only (incl. `query_sql`, `save_user_wallet`, `upsert_wallet_moments`, `pinnacle_upsert_nft_map`, `activate_pro_from_payment`, `classify_acquisition`). RLS on all 88 tables. 17 SECDEF views dropped.

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

**Status reconciled 2026-05-23** against the codebase + production DB. Full verification table: `PROJECT_HEALTH_2026-05-22.md` §9. Item numbers below are stable (they match the report); resolved items are listed at the end under their original numbers.

### Platform changes (May 2026) — these make several sections of this file stale

- **Flowty shut down its NFT marketplace (~2026-05-13).** The external Flowty event indexer, `flowty_loans` / `flowty_loan_events` ingest, the Flowty analytics materialized views, the Flowty leg of the sniper feed, the `flowty-proxy` edge function, and all Flowty-sourced ASK/FMV inputs are now frozen. The "Flowty API", sniper-feed, and worker sections of this file describe what is now legacy/dead infrastructure pending a deliberate teardown. `flowty_loan_events` going cold on 2026-05-11 is expected behaviour, not a regression.
- **NFL All Day ended primary pack sales.** AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only; AllDay is a secondary-market collection going forward.

### Open

1. **Cart execution — SHELVED (2026-05-24, intelligence-first decision).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence code in `lib/cadence/purchase-moment.ts` stays in the repo, dormant and revivable, but off the critical path — do NOT pursue H1/H2 or the external deps (`NEXT_PUBLIC_WALLETCONNECT_ID`, Dapper co-signer registration). Market/Sniper were reframed 2026-05-23 (commit `b19d8f2`) to FMV + discount intelligence with outbound "View Listing" links. `docs/audits/purchase-moment-2026-05.md` retains the historical Cadence detail.

3. **Trade Hub — SHELVED (2026-06-01), same class as Cart #1.** On-chain trade escrow (`RPCTradeEscrow`) is not deployed; the 5 submitters in [lib/trade-escrow/fcl-submit.ts](lib/trade-escrow/fcl-submit.ts) were returning fake `0xstub_` tx ids, implying swaps that never happened. Guarded 2026-06-01: each submitter calls `ensureLive()` (throws unless `RPC_TRADE_ESCROW_ADDRESS` is set); the live routes `/api/trade-chain/{propose,execute,deposit-callback}` + `/api/admin/reclaim-expired-trades` return 503 "Trade Hub is not available yet."; `/dashboard/trade-hub` `notFound()`s via a server gate (split into `TradeHubClient.tsx`). The wishlist/offers/matches CRUD (`/api/trade-hub/*`) is untouched. To re-enable: deploy the contract, set `RPC_TRADE_ESCROW_ADDRESS`, and replace each stub body with the real `fcl.send` per the file's NEXT_STEPS + `RPCTradeEscrow_DEPLOYMENT.md`. Revert the guard: `git revert`.

4. **Pinnacle FMV — RESOLVED (verified 2026-05-24).** The "0 FMV editions" claim was stale. `pinnacle_fmv_snapshots` holds 425 editions (every Pinnacle edition traded in 90d), 84% HIGH+MEDIUM confidence, recomputed daily by algo `pinnacle-1.0.0` and propagated to `wmc` hourly by `populate-pinnacle-wmc-fmv`. Pinnacle ASK now comes from `pinnacle-listings-indexer` (direct-chain), not Flowty. Note: Pinnacle FMV lives in its own `pinnacle_fmv_snapshots` table, NOT the uuid-keyed `fmv_snapshots`.

7. **AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25.** The earlier "historical spork scan" framing was wrong: the backlog is not spork-era data. All 2,550 NFL All Day unmapped rows are under 6 weeks old and were starved by the resolver running at `batch_size: 5` against a Flowty-only lookup. Fixed by the GQL-primary edge-function rewrite + `batch_size 5→200` bump in the 2026-05-25 (latest) session above. The Pinnacle side is separately covered by the direct ASK pipeline (Phase 2C, 2026-05-11). The `spork-proxy` worker remains live for any genuinely spork-era investigation but no longer blocks the unmapped-sales backlog.

9. **Storefront audit pipeline — RETIRED (verified 2026-05-24).** It is a manual script (`scripts/scan-historical-storefront.mjs`), not a deployed cron or route — not monitored, not read by any frontend code. Cold since 2026-04-28 simply because nobody runs the script. De facto retired; no operational action. `storefront_audit_wallets` (5,365 rows, tiny) is harmless — optional drop candidate.

10. **`/dashboard` token migration** — `app/dashboard/page.tsx` ~1,750 lines. Big lift, defer until stable.

11. **Brand punch list — partial.** Per-feature OG cards exist (`/api/og/{collection,deal,moment,pack,profile,fast-break,default}`). Still missing: the `/home-fmv-preview.png` home screenshot. Fast Break / RTR / admin tokenize once stable.

12. **Blazers trivia** (`lib/blazers-trivia.ts`) — 29 items shelved, still no UI.

14. **Monolith page refactor** — `collection/page.tsx` (~2,900 lines), `sniper/page.tsx` (~2,070), `analytics/page.tsx` (~2,208). Phase 1 plan in `docs/audits/refactor-plan-monolith-pages-2026-05.md`.

15. **`livetoken-portfolio*.json` fixtures — RESOLVED (verified 2026-06-01).** No longer tracked (`git ls-files` returns none for `livetoken-portfolio*` / `nftlocker-*` / `flowty-locker-test.json` / `test-gql.json`); nothing left to `git rm`.

17. **Pack / Moment / Set page tune-up — ongoing.** File:line audit findings live in `PACK_PAGES_AUDIT_2026-05-22.md`, `MOMENT_PAGES_AUDIT_2026-05-22.md`, `SET_PAGES_AUDIT_2026-05-22.md` — those docs are point-in-time and now partially superseded; the current state is here.

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
- WMC backfill (May 7): TS 99.8% tier / 100% set / 89.6% mint via `UPDATE FROM editions JOIN`. AllDay/UFC limited by editions-table coverage gap. 18 RPCs read `wmc.tier` directly — backfill approach preferred over per-RPC patches.
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
