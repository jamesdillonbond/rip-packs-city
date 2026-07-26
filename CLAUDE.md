# Rip Packs City — Claude Code AI Assistant Configuration

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## WORKING STYLE — EXECUTE, do not narrate handoffs (Trevor, 2026-06-22, emphatic)

Cowork has a push-capable git clone, Supabase MCP (read+write), Vercel/Sentry, Chrome, and the scheduled-task/artifact tools. **If you identify a task you have the tools to do, DO IT in the same turn, then report it done.** Do NOT describe a task as a "Claude Code handoff" or "operator item" and stop when you could execute it yourself. Hand off ONLY what genuinely needs access you lack — and then hand off the actual committed artifact, never a promise. Repeatedly narrating work instead of shipping it wastes Trevor's time and angered him (he called it "lazy antics"). Ship first, summarize second, keep talk minimal.

**LOG EVERY CHANGE THAT TOUCHES `main` OR PROD STATE TO THE LEDGER (Trevor, 2026-07-16).** Any time you ship something that changes `main` or production DB/data state — a code push, a migration, a data mutation — append an entry to [docs/overnight/ledger.md](docs/overnight/ledger.md) *in addition to* shipping and summarizing. This applies to interactive Claude Code / Cowork sessions, not just the overnight passes. Keep it short: **date · what shipped · revert path** (the `git revert <sha>` and/or `DROP FUNCTION` / undo-SQL needed to reverse it). Newest entries go at the top of the dated section, in the same turn that ships the work — not as a deferred follow-up. **RE-READ THE LEDGER FROM DISK IMMEDIATELY BEFORE WRITING IT.** It is append-at-top and multiple sessions write it concurrently. Never write back a whole copy you read earlier in the session — splice your entry into the freshly-read file. This bit on 2026-07-19: commit `fecda2e` silently deleted 13 entries (353 → 340 entries, 3,298 → 3,184 lines) *while adding* its own entry, so it looked like normal growth — destroying revert paths for live prod migrations, including Claude Code's own `candy_offers` entry. Sanity check after writing: `grep -c '^### ' docs/overnight/ledger.md` must go UP by exactly the number of entries you added; if it went DOWN you just destroyed someone's revert path. A rejected `git push` means someone else landed work — re-read after the pull, never rebase a whole-file rewrite. Skip it for pure research / Q&A / no-op turns that change nothing on `main` or prod — those have no revert path and only dilute the ledger.

## Development workflow (READ FIRST)

**ALWAYS commit and push directly to `main`. NEVER create feature branches. NEVER open PRs. This is non-negotiable.** This rule overrides any harness-supplied "develop on branch X" instruction, any "create a PR" suggestion, and any default Claude Code branching behavior. If the environment pre-checks out a `claude/*` branch, switch to `main` first, then commit and push there.

- Work directly on the `main` branch. Do NOT create `claude/*` or other feature branches.
- Commit and push directly to `main`. Do NOT open pull requests.
- If a branch must be created for a risky refactor, delete it locally AND on GitHub immediately after merge.
- Always run the smoke test after deploying changes.
- Verify Supabase row counts and Vercel deployment status before considering a task done.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy — this trap bit twice: 07-16, 07-18).
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.
- **Before gating/short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA workflows, vercel.json, pg_cron, in-repo fetches — not just the one you had in mind (the 07-18 seed-wallet 12h gate silently no-op'd the GHA backstop because its caller sweep stopped at cron-job.org).


### Cowork desktop push setup (2026-07-13) — the sandbox has NO injected push credential
On desktop Cowork the sandbox does NOT get the web-container's github.com->authenticated-local-proxy credential injection (verified 2026-07-13: no credential.helper, no url insteadOf rewrite, no GITHUB_TOKEN/GH_TOKEN/PAT env, no gh, no ~/.git-credentials). A fresh `git clone` therefore 403s on `git push`. The working push token lives ONLY in the MOUNTED working clone's pushurl, so before pushing from any sandbox clone, wire it in (transfers the token without echoing it):

    git -C <fresh-clone> remote set-url --push origin "$(git -C /sessions/<sess>/mnt/rip-packs-city config --get remote.origin.pushurl)"

This is INDEPENDENT of the bash/useradd sandbox-disk failure — bash-green does NOT imply push-green. Still never commit from the mount itself; always a fresh clone (deploy-split rule).
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

Working thesis (confirmed 2026-05-30): RPC is a **sports / IP digital collectibles intelligence platform**. Flow is chain one of N. **Sequencing rule UPDATED 2026-07-16 (Trevor): expansions are READINESS-gated, not sequence-gated — ship whichever segment is ready, in parallel if need be. The old "one at a time, never parallel, Candy-first" rule is retired.** Each segment must still be fully integrated, stable, and quality-bar-clean before its own public go-live; readiness is the gate, ordering between segments is not.

**Chain one (flagship):** Flow. NBA Top Shot, NFL All Day, LaLiga Golazos, UFC Strike, Disney Pinnacle. Quality bar does not drop while chain two is built.

**Solana / Candy Digital (in prep):** its OWN readiness trigger is still ≥30 days of Candy Solana sales history (earliest 2026-07-08) + a defined edition/serial schema RPC can index (chain-abstraction Phases A-F already complete). This gate is Candy-specific and does NOT gate other segments. **Drop 1 (2026 MLB Base Series ICONs, $10/pack, 500 packs) landed Jul 17 2026 — Item-0 discovery is COMPLETE and ingested: 125 `candy_mlb` editions / 25,375 serials, daily refresh cron live; `candy_mlb` stays `is_active=false` until the surface is quality-bar clean** (per roadmap-2026-07-18 Phase 4). The Helius proxy secrets are LIVE (operator gate closed 07-16; DAS verified end-to-end); Trevor's Candy Solana wallet is `63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY`. Do NOT treat `candy_mlb` rows / candy `pipeline_runs` as anomalies. **2026-07-19 readiness push:** the data layer reached shared-schema parity minus FMV — tier/set/player/series filled on all 125 editions (`candy-*`-namespaced `sets`/`players` rows), wmc denormalized, 371 ghost-owner rows purged with a daily self-heal (pg_cron `rpc-candy-wmc-ghost-purge`, jobid 201; the DAS group-walk never deletes the prior owner's row on transfer), wmc = 25,375 = supply exactly. The **Magic Eden sales indexer is LIVE** (`candy-sales-indexer`, `CANDY_MLB_ME_SYMBOL` = `2026_mlb_base_series_icons_candy_digital`, Vercel cron `20 */3 * * *`) — first tick 07-19 03:20Z **ok=true, 0 sales** exactly as designed (`SALE_TYPES` excludes `bid` so the bid-only book yields nothing; the first printed sale is captured automatically), and it **proved Vercel egress reaches Magic Eden** (the cloud sandbox is proxy-blocked; prod is not). **Best-offer capture SHIPPED 2026-07-19** (`audit_20260719_candy_offers_scaffold`): table `candy_offers` (PK `pda_address` = the ME standing-offer identity) + view `candy_best_offers` (per-edition max offer with `distinct_bidders` + `offer_count` alongside), fed by route `candy-offers-indexer` (`/api/ingest/candy-offers`, Vercel cron `50 */6 * * *`) — sweeps ME `bid` activities → per-bidder standing offers → Candy-mint gate via `wmc` → upsert; deactivates unseen rows ONLY on a complete sweep (a partial sweep never marks standing offers dead). **HONESTY CONSTRAINT (binding): `candy_best_offers` is a BEST-OFFER signal, NEVER FMV — never fold into `fmv_snapshots`.** **Remaining Candy go-live blocker: zero price signal** (0 sales / 0 FMV / 0 asks; only ME *bids* exist). The bid book is thin and its size is measurement-dependent (probes disagreed 1 vs 2+ wallets; SOL ≈ $76, so observed 0.003–0.04 SOL bids ≈ $0.23–$3.04) — the `candy_offers` pipeline is the arbiter, not any one probe. Whether a bid-derived best-offer reaches a surface at all is a **product decision** (currently there is nowhere to render it — `candy_mlb` has no route dirs and stays unpublished), so silent accrual is correct. **2026-07-24 productization update — the price signal ARRIVED and the first gated surface shipped (supersedes "zero price signal"):** Candy is now printing **~53 sales/24h** (gated, expected — not an anomaly), FMV is computed by the standard collection-agnostic `fmv-recalc` (algo `1.7.0`, **46/125 editions priced, all LOW-confidence off 1–2 sales**; the 79 zero-sale editions stay honest FMV-`—`). Shipped: the **ask feed Candy never had** — `candy_listings` table (PK `pda_address` = ME listing PDA) + `candy_listing_floor` view, fed by route **`candy-listings-indexer`** (`app/api/candy-listings-indexer/route.ts`, Vercel cron `35 */3 * * *`; a Next.js route, NOT a worker — ME page-size capped at **`limit=100`**, 500→HTTP 400, fixed `58cf0818`) — plus **`candy_secondary_board`**, **`candy_pack_ev_model`** (supply-weighted $10 pack = 10 ICONs + 15% Rainbow; **Actual EV ~$86 vs Typical Pull median ~$26**, Rainbow leg largely unpriced), and the **Items A2–E parity boards** (`candy_scarcity_board` / `candy_holder_board` [246 collectors, treasury excluded] / `candy_special_serials_board` [500 rows] / `candy_parallel_player_boards` [Core ~$5.70 vs Rainbow ~$170 FMV, ~30×] / `candy_deals_board` / `candy_offer_spread_board`). The first **gated public board** is live at **`/insights/candy-mlb`** (server page + client + `/api/public/insights/candy-mlb`, tabs Market·Deals·Spread·Serials·Scarcity·Holders·Players; `noindex`; pack-EV block **leads with Typical Pull, not Actual EV**), walled by a NEW `proxy.ts` line gating `/insights/candy` + `/api/public/insights/candy` (Candy was NOT previously route-gated — only Panini was). **Every new Candy table/view is anon+authenticated SELECT-REVOKED** (verified `has_table_privilege` false), read via `supabaseAdmin`. **HONESTY CONSTRAINTS held:** listings/offers are ASK/BID floors, NEVER folded into `fmv_snapshots`; deals/floor read 0 until the first ask prints (ME `listedCount` was 0 under the quest-hold, ~15 asks now ahead of Drop 3). **Go-live (Trevor's call, separate):** delete the `proxy.ts` line + sitemap slug + hub card + OG + drop `noindex`; `candy_mlb` stays `is_active=false`. The board reads Candy **directly**, so it needs neither the `is_active` flip nor the queued 28-shared-RPC candy-arm fix. **Benign flag (owner action):** the ~11 new Candy views trip `check_public_security_invariants()` `view_unexpected_definer` because they're `security_invoker=true` (Cowork normalized them to `=on` in `audit_20260724_candy_view_invoker_normalize`; the invariant matches only `=on`); no leak (all anon/authenticated-revoked), clears once allowlisted.

**Panini (in prep, INDEPENDENT — runner LIVE as of 2026-07-18):** the residential logged-in box now runs `scripts/ingest-panini-runner.mjs` on Windows Task Scheduler every 4h (`scripts/panini-schedule.bat` registers it, no admin; walk order shuffled so stalled runs rotate coverage `0736fbc4`; pack market data posts up-front `fcc55f27`), live-refreshing ~1,022 editions into `panini_editions`/`_fmv_snapshots`/`_pack_state`. The public surface `/insights/panini-squeeze` (server page + client board + public JSON `/api/public/insights/panini-squeeze` + OG card) is BUILT and STAGED behind **one proxy.ts line** (~L127, regex matching `…/panini` across page/api/og — go-live = delete that line + add sitemap/hub links, see roadmap R5). Pack-EV methodology docs v0.2–v0.4 live under `docs/` (remaining-pool basis; FOTL guaranteed-exclusive-slot edge vs Hobby ~fair) + a WC Nations sealed-value board. The superseded pull-model scaffolding (feed.ts, old normalize.ts, 3 inert cron/ingest routes) was retired `45038b8a`. See [docs/strategy/panini-roadmap-2026-07-16.md](docs/strategy/panini-roadmap-2026-07-16.md). **2026-07-19 CRITICAL finding — discovery is listing-GATED (supersedes the "~20% and listing-biased" note): THE Panini go-live blocker.** The runner enumerates from GraphQL op `getMarketPlaceList` (marketplace listings), so an edition enters the index only once LISTED; of 1,647 discovered editions only **47%** sit in a trustworthy-coverage bucket, and coverage falls monotonically with scarcity (1-of-1 parallels 7–8% discovered, 100% of those currently listed). Measure via the `panini_coverage_audit` view (+ `panini_coverage_summary` for the one-row headline); the dead-end lanes (crafted GQL → 426, psku derivation, fetch override) are documented in [docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md](docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md) — do not re-derive them. **2026-07-19 update — Item 1 RESOLVED: Panini exposes NO full-checklist route** (the SPA has no catalog endpoint to repoint enumeration at), so the only remaining lane is **branch 2b: accept the listing-gated coverage and DISCLOSE it** on any public surface. That disclosure is now **built into the squeeze surface structurally, not as a checklist item** — `panini-squeeze/page.tsx` fetches `panini_coverage_summary` and renders a "treat this board as a floor, not a census" banner, and the public JSON `/api/public/insights/panini-squeeze` carries `meta.coverage` (`basis: "listing_gated"` + note), both fail-soft. The runner is instrumented to capture `/onepanini` request payloads (`PANINI_OPS_CAPTURE_FILE` + `PANINI_DISCOVERY_HOLD_MIN`/`_ONLY`) for one last operator-driven confirmatory pass, now OPTIONAL. **psku correction: `packcard-<setId>_<parallelSetId>_<cardId>_<playerId>`.** Five additional built Panini boards stay deliberately unsurfaced. Go-live is still the single `proxy.ts:127` deletion (+ sitemap/hub links, ordered AFTER the un-gate); the honesty requirement now travels with the surface.

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
- Phase D — **SHIPPED 2026-05-30** (Claude Code, commits `01b3878` (moves) + `1b7cfde` (shims), deploy `dpl_2weTJexPvEjXaQxjccrEckDctSWB` READY). Relocated 18 Flow-specific modules under `lib/chains/flow/` (incl. `flow.ts`, `topshot.ts`, `allday.ts`, the `cadence/` scripts, `dapper-v1-tx-decode.ts`, `wallet-backfill-helpers.ts`) behind backward-compat shim re-exports at every old `@/lib/...` import path; zero caller breakage across 833 imports. The `lib/flow.ts` default-export trap was handled — its two-line shim carries `export { default } from "@/lib/chains/flow/flow"` alongside `export *`. Stay-at-top-level files preserved (`lib/evm-rpc.ts` stayed on the Base/EVM plane, not in the Flow dir). 48h production soak clean (2026-05-30 17:10 -> 2026-06-01 17:10 UTC) — closeout via scheduled task; reorg was staged explicitly by path to avoid the concurrent-session hazard ([[cross-session-git-add-a-staging-hazard]]). Plan: [docs/handoff-phase-d-lib-chains-flow-reorg.md](docs/handoff-phase-d-lib-chains-flow-reorg.md). **Update 2026-07-19: ALL 18 shims are now zero-caller** — every in-repo caller (incl. test `vi.mock` paths) repointed to the canonical `@/lib/chains/flow/...` paths (`119dfb03` + `6be46cef`). **Update 2026-07-25 (Claude Code): all 18 shim files DELETED** (Trevor-authorized override of the chain-two gate — they were verified zero-caller via alias + relative-path grep across all code file types). The canonical modules under `lib/chains/flow/**` are now the ONLY import path; new code MUST import `@/lib/chains/flow/...` — the old `@/lib/...` shim paths no longer resolve. Revert: `git revert <sha>` restores the 18 re-export shims.
- Phase E — chain-aware reads audit; classify each surface as Flow-internal / assumes-Flow / needs-chain-dispatch. **SHIPPED 2026-05-30** (Claude Code, `205024c`) — [code-side](docs/audits/chain-aware-reads-2026-05-30.md): 168 surfaces (80 chain-internal / 85 assumes-Flow / 3 needs-chain-dispatch); [DB-side](docs/audits/chain-aware-reads-db-2026-05-30.md): ~75% of collection-aware DB code reaches chain via `collection_id` FK. Key finding: only 3 code surfaces need chain-dispatch (squeeze-check + tc-report wallet-paste tools, lib/collections.ts URL builders); a parallel EVM data plane (Base/Beezie, `evm_*` registry) already exists outside `collections.chain_type`.

**Beezie/Base parallel data plane — decision: keep parallel for now.** The `evm_*` registry (1.01M Beezie transfers, 1,828 holders, cron `evm-transfers-ingest` since 2026-05-13) stays separate from `collections.chain_type` until either (a) Beezie gets a real product consumer (FMV / badges / portfolio query) or (b) the July 8 Candy/Solana tripwire fails and Beezie/Base becomes the chain-two pivot target. Promoting now would still be premature (no product consumer yet); the 2026-07-16 readiness-gated rule permits parallel builds, but Beezie/Base has no reason to promote until it has a consumer. Bridge cost is bounded when needed: `ALTER TYPE chain_type ADD VALUE 'base'` + seed a `collections` row + bridge `evm_nft_transfers` into `editions` is the migration path. Memory: [[rpc-beezie-base-indexer-discovery]].

**Phase F — SHIPPED 2026-06-01** in `audit_20260601_collections_chain_drop_default` (`ALTER TABLE public.collections ALTER COLUMN chain DROP DEFAULT`). `collections.chain` no longer has a DEFAULT (was `'flow'::chain_type`); the column stays NOT NULL, so future `collections` inserts must specify `chain` explicitly. Smoke-verified `column_default` NULL. Rollback: `ALTER TABLE public.collections ALTER COLUMN chain SET DEFAULT 'flow'::chain_type`. Chain-abstraction workstream complete (Phases A through F shipped).

**Worker / proxy implication for chain two:** new chain workers (e.g. `helius-proxy` for Solana RPC) get a NEW auth-secret surface, never sharing `TS_PROXY_SECRET` or `INGEST_SECRET_TOKEN` rotation. See "Worker auth surfaces (3 rotation domains)" below.

---

## Recent sessions

> Keep only the last ~3 days here. On each refresh, move older `### <date>` entries into `docs/sessions/YYYY-MM.md` (prepend, newest-first) — verbatim, so nothing is lost. Busy days run several entries, so this section may hold a dozen-ish; if it's carrying more than ~3 calendar days, roll the tail.

### July 26, 2026 (Claude Code, interactive) — SHIPPED the multi-factor pooled special-serial FMV model (handoff Item 5, was data-gated) end to end: built → tuned → trend-mined → extended to every surface → made reproducible

The Item-5 model from `docs/archive/handoffs/handoff-2026-06-19-ts-sales-completeness-and-serial-fmv.md`, unblocked once the sales-completeness backfill drained (#1 sales ~1,086 → ~4,000 canonical; only ~1,791 are *modelable* = on HIGH/MED-base editions, the population `serial_fmv_estimate` serves). Full detail + per-ship revert paths in the six 2026-07-26 ledger entries; design/trends in `docs/models/topshot-pooled-serial-fmv-2026-07-26.md` + `topshot-special-serial-trends-2026-07-26.md`; reproducible fit pipeline in `scripts/serial-fmv-pooled/` (`export_v12.py` regenerates the LIVE model exactly).

- **What it is:** a **pooled hedonic (ridge) regression** fit **OFFLINE in Python** (ridge = partial pooling), coefficients written to service_role-only tables, applied at read time in pure SQL. **At read time it collapses to a per-edition power law `est = k_edition · fmv^b_log_fmv`** — a few indexed lookups, always fresh (fmv/circ/tier read live; only learned multipliers stored). **A multivariate ridge fit CANNOT be reproduced in pure SQL (Postgres has no lstsq), so the "weekly pg_cron refit" the spec imagined is infeasible — refit is a periodic OFFLINE job.** Because base_fmv is read live, only the learned multipliers are static and they drift slowly.
- **Factors (all four Trevor named were tested):** `set` is the dominant, stable factor (~125× premium spread across well-sampled sets — this IS the model). **`player` and `badge` were both evaluated and REJECTED** under shrinkage — player doesn't generalize forward (star premiums are volatile / already in base FMV); badge is redundant with set (the premium lives in the *set*, e.g. `Rookie Debut` set 100× vs the `Rookie` *badge* 13×). `series`/`team`/`parallel` dropped per the 06-19 factor analysis. Live model = **v1.2.0 = set-only + 180d-recency-weighted fit + the jersey-#1 double-special** (a serial #1 of a player who also wears #1: real, distribution-wide, ×1.38; COMMON-controlled 51.8× vs 35.1×). Validated OUT-OF-SAMPLE via rolling 5-fold forward-chaining time CV, both models refit per fold: **pooled med-APE ~0.575 vs the incumbent power-law ~0.69 (~16% lower), broader coverage.**
- **Tables** (service_role-only, RLS on, anon/authenticated REVOKED — the model is read only by the SECDEF estimate fn): `serial_fmv_pooled_model` (global coeffs + params + `is_active` kill-switch + `jersey1`), `serial_fmv_pooled_set_effect` (71 sets, support≥6), `serial_fmv_pooled_player_effect` (empty — kept so player can be seeded later with no schema change). **Kill-switch:** `UPDATE serial_fmv_pooled_model SET is_active=false`.
- **Read path:** `serial_fmv_estimate` gained a **canonical 8-arg** `(cid, serial, circ, tier, fmv, confidence, jersey_number, edition_id)` = pooled→jersey→power-law→grid; the 6-arg / 7-arg-integer(jersey) / 7-arg-uuid(edition_id) overloads all **delegate** to it. Pooled fires ONLY when `p_edition_id` is passed, the model is `is_active`, and the edition's set support ≥ `gate_min_support` (=6); else the exact prior power-law/grid path (so every caller is byte-identical with edition_id⇒NULL). TS-only (no pooled row for other collections → they stay on power-law).
- **LIVE on every serial-estimate surface** (was board-only): the underpriced-serials board (`topshot_serial_board_candidates`), the moment page (`get_moment_detail`), wallet (`get_wallet_moments_with_fmv`), trophy (`get_trophy_slab_data`), top-owned (`get_user_top_owned_moments`), and the sniper ticker (`app/api/sniper-feed/route.ts`, resolves the deal's edition uuid via `intEditionKey`). Each passes `edition_id`; unresolved/non-TS → unchanged power-law. Returns `basis:'pooled_model'` (+ `jersey1_match`, `set_support`) so surfaces distinguish engines. Verified live: moment 49949610 → `pooled_model`.
- Migrations `20260726010000`–`016000` (+ four dated `audit_20260726_get_*_pooled_edition_id` MCP migrations for the consumer cutovers). All 6 CI jobs green; security invariants `[]` throughout. **Open (deliberate) follow-up:** a DB-invariant SQL test pinning `serial_fmv_estimate`'s pooled behavior — worth adding once the function settles.

### July 25–26, 2026 (Claude Code, interactive — 12-batch test-coverage program, cont. 36–47) — coverage 85.1→87.8 stmts / 70.1→72.8 branch / line coverage crosses 90%; four ZERO-coverage Cadence write templates covered; four `after()` cron bodies that had never actually run

Test-only and behavior-preserving throughout — **no product code, no migration, no `vercel.json`, no FMV/EV/pricing logic touched.** Twelve batches to `main`, each with its own ledger entry + revert path in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-25/26, "cont. 36" … "cont. 47") and its own dated block in `vitest.config.ts`. Suite 841 → **866 files / 6,637 tests**, 0 failures; `tsc --noEmit` clean at every push. Ratchet 76.3/61.45/82.0/78.9 → **87.3/72.3/90.3/89.85**.

**THE DURABLE METHOD LESSON — derive the gate table BOTH ways, and include `lib/`.** I ranked targets by *uncovered branch count over routes* for six batches and twice declared the work exhausted. Re-deriving by **statement %** surfaced **four files at literally 0%** the branch ranking had hidden (a file with no branches can be 0% covered and never appear); re-deriving with **`lib/**` included** (I had been filtering to `app/api/**/route.ts`) surfaced seven more pure modules below the route average. The two rankings hide different things — run both, and never work from a remembered list (that mistake is now recorded three times in the ledger).

- **The four Cadence write templates were at 0% *because* they are shelved** (Cart #1, Trade Hub #3, and gifting has never run end-to-end — `moment_gifts` has 0 rows). Nothing exercises them, so a bad edit would sit undetected until someone revived the path and signed a real transaction with it. `__tests__/cadence-transaction-templates.test.ts` now pins Cadence 1.0 syntax (no `AuthAccount`, no `pub`, every signer an entitled `auth(...) &Account`), the mainnet addresses this file enumerates, purchase-moment's **two** signers + DUC-leak `post{}`, gift-moment's **single** signer, and that Flowty's `0.00025` royalty was not copy-pasted from Top Shot's `0.05` (a 200× overcharge). **Gotcha:** count `&Account` in the prepare header — the obvious `prepare\(([^)]*)\)` regex stops at the `)` inside `auth(BorrowValue)` and silently reports 1 signer for a 2-signer transaction.
- **Four small admin/cron routes' `after()` bodies had never run in tests** (`refresh-error-triage` 33.3→100% st, `prune-pipeline-runs` 56.3→100%, `drain-fmv-cold-tail` 56.4→100%, `migrate-acquired-at` 57.1→100%). Their tests all stopped at the 401/202 — the exact silent-run shape of the 06-10/06-11 dark-run incidents. Now pinned: the `pipeline_runs` row that IS the only failure signal now the HTTP answer is always 202; `p_retention_days` (**not** the spec's `p_keep_days` — a wrong arg name is a silent no-op against a SECDEF RPC); and the 06-11 fix that a slug which *throws* must not abort the drain loop before the insert.
- **Security/honesty contracts that existed only in comments.** `/api/email/subscribe`'s header states the email is the session's and clients can't pass an arbitrary `email` — untested; a body-supplied address would send confirmation mail to anyone from our domain (58.5→100% st). `/api/badges`' **play-tag allowlist** — Top Shot mixes ~6 real badges with ~25 gameplay descriptors, so dropping the filter sprouts fake badges on every moment, the same fabricated-signal class as the 07-25 pack-EV P0 (52.6→100% st). `/api/analytics` returns `acquisition: null` rather than zeros for non-Top-Shot collections, because zeros read as "pulled nothing from packs" (58.2→100% st). `edition-floor`'s **persist half writes `fmv_snapshots`** and was entirely undriven: ULTIMATE editions skipped (owned by `recalc_ultimate_fmv`), only *today's* rows deleted (60.8→94.2% st).
- **The `sales` family, done as a set.** All four `cron/*-sales-history-backfill` walkers now carry one ported edges suite, so a defect in the shared shape fails in four named places: the **23505 row-by-row retry** on both `sales` and `unmapped_sales` (these have the CORRECT shape — the positive-23505 branch *is* the retry), `?dryRun=true` writing nothing, and the spork-floor 404 vs any other failing status. Also the golazos/ufc listings-indexer twins (first-run sealed-tip anchor, batch→per-row upsert fallback, DUC/FUT-only `price_usd`).
- **Also raised:** `wallet-search` 55.5→64.3 br (league filter `.range()` paging, the FMV `play_id_onchain` fallback re-applying the >$10K ceiling), `smoke-test` 55.3→70.9 br (the two Pinnacle data-correctness probes + the crash guard that must still answer 200 because the CI gate parses the body), `fmv-recalc` 50→59.3 br (`?force_stale=true` touches COLD editions only), `pack-ev`, `admin/rewards`, `allday-fmv-populate` (the double ULTIMATE guard), `cache-refresh` (the $10K FMV ceiling both ways), `pinnacle-metadata-backfill` queues 2–4, plus 7 pure `lib/` modules.
- **One correction recorded, not "fixed":** `searchPinnacleByName` is deliberately the odd one out in `lib/concierge/pinnacle-router.ts` — it returns a typed object and **propagates** rather than returning a `{status:"error"}` envelope, because support-chat's `search_across_collections` is its error boundary. The test pins the propagation; swallowing there would report a clean "0 results across collections" for a DB outage.
- **Closed for cause (do NOT re-chase):** `support-chat` (deliberate partial, cont.28 — ~25 bespoke per-tool fixtures for diminishing return), `cron/pinnacle-listings-reconcile` (uncovered lines sit after `const ASK_UNIFY_RETIRED = true` — unreachable rollback code), and the four *forward* `*-sales-indexer` routes (residue is live Flow-REST/Cadence scan bodies). **Still open, all small:** `admin/evm-health` (37 stmts), `cron/resolve-topshot-stubs` (39), `cron/backfill-pack-pull-source-rip-id` (43), `profile/hero-moment` (43), `cost-basis` (34), `support-chat/feedback` (43), `wallet/pack-history` (42), `ufc-pipeline` (21).
- **Recurring trap, fifth+ occurrence:** a `vi.hoisted` mock state initialised `data: [] as any[]` then assigned `null` on an error-path case reds the **blocking** `typecheck` job for every concurrent session. Cleared 8 such pre-existing errors off `main` in cont.36. `vitest` does not run `tsc` — run `npx tsc --noEmit` before pushing a new test file.

### July 25, 2026 (Cowork, interactive — full-day session) — P0 fabricated pack EV killed at the read layer; a decorative CI gate that had "passed" 3,072 runs; silent wmc upsert loss under a "0 failures" pipeline; 9 perf rewrites; 90 migrations

Full detail + per-item revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md) (the 2026-07-25 Cowork entry). **90 migrations landed today**; 77 carry their own inline REVERT.

- **P0 — `pack_table_rows` was publishing FABRICATED pack EV.** Disney Pinnacle dist 8537: a **$4.99 pack showing gross EV $2,651.21 / typical $1,929.00 — a 531× ratio**; `NFL Pack Hold - Genesis` publishing **$900,000** gross EV on **3%** FMV coverage. Fixed with three **read-layer** guards (drop pool must exist · pack price < 9999 sentinel · FMV coverage ≥ 25%) rather than touching EV math. **Published EV rows 1,024 → ~1,000; max value ratio 531× → 15.3×.** **Revert:** `audit_20260725_pack_ev_require_drop_pool` + `audit_20260725_pack_ev_suppress_sentinel_price_and_thin_coverage` (each comment carries the exact restore).
- **SILENT DATA LOSS — a legacy 2-column unique index on `wallet_moments_cache`** (`lower(wallet_address), moment_id`) was **discarding whole upsert chunks while `pipeline_runs` reported 0 failures across 3,497 runs**. Dropped after proving no `ON CONFLICT` caller inferred it and that **6,394 moment_ids legitimately exist in 2 collections** — the index enforced a constraint that is false in the domain. **Frees 186 MB.** `audit_20260725_drop_legacy_wmc_two_col_unique_index` (its revert will FAIL once a wallet holds one moment_id in two collections — that failure confirms the drop was right).
- **CI — the Smoke Tests GHA gate had been decorative for 3,072 runs**: it parsed a `failed` key the route never returns, so it could not fail. Now gates on `hardPassed`/`hardTotal` with a contract test. **Security:** the standing invariant breach closed plus the wider class — **9 internal `audit_*` tables** had stray anon/authenticated grants (all hardened), anon EXECUTE revoked on `get_allday_listing_serial_targets`. Both invariant checks verified clean at end of session.
- **Perf (all live-verified):** `holdings_summary` **10.65s→0.24s (44×)**; All Day dedup cron **453s→14s**; rip-value rollup **191s→0.077s**; `analytics_sales_summary` **19.2s→1.0s** (equivalence proven across 15 cases); `v_rpc_trust_health` **>60s timeout→fast** via 6-hourly precompute (all 20 metrics preserved); `get_market_pulse_windows` **50,780ms→544ms (93×**, was over the 30s ceiling); `v_topshot_pack_market` **1,025ms→8ms (128×)**; `pipeline_health_24h` **19,371ms→4.1ms**; remap rotating window **110.4s vs a 600s ceiling**. **Data:** Golazos ownership fixed after **1,325 consecutive zero-result runs** (44 rows/1 wallet → **9,494 rows/115 wallets**); All Day unmapped's three no-progress loops fixed (only **14 of 43,066** rows were ever promote-eligible) + a backlog/resolve-ratio detector.
- **HYGIENE CLOSEOUT — the wmc lock-freshness "crisis" was the METRIC, not the pipeline (`audit_20260725_wmc_freshness_metric_truth`).** The carried alarm ("`MAX_AGE_DAYS=7` ~70× oversubscribed, 79% of rows stale") **collapsed two independent columns**. Ownership freshness is healthy: `wallet-backfill` enumerates each wallet's COMPLETE on-chain id set every run, so the `skip_cached` path CONFIRMS ownership and writes nothing — **2,390,895 confirmations/24h vs ~291,192/day needed (~8.2× surplus)**, **250 wallets walked in 72h vs 246 distinct TS wmc wallets**. `last_seen_at` is a **content-change** watermark (change-detect skips unchanged rows), not a verification watermark. **Fixed the metric, not the data**: a blanket bump would be **~2.39M UPDATEs/day on a 2.05M-row/800MB hot-write table**, and the right grain already existed and was already written — `wallet_backfill_state.last_scanned_at`. New `check_wmc_ownership_freshness()` (0 rows = clean) returns **4 rows / ONE wallet at 9.25 days** in place of the 1.61M-row alarm. `lock_checked_at` IS genuinely oversubscribed and was deliberately left alone, honestly labelled.
- **HYGIENE — `special_serial_holders` retired (25 rows vs ~56,202 targets, 0.04%, last written 2026-07-05).** Its three readers are consumed only by unscheduled edge functions, so **nothing was dropped** — all labelled DORMANT. But `app/moment/[id]/page.tsx` read the empty table for hero badge pills, so **"Jersey Match" could never render** and an empty pill row was indistinguishable from "not special". **Repointed at the wmc-backed `get_edition_special_serials` the same page already calls — removes a DB round-trip.** `audit_20260725_retire_special_serial_holders_dead_path`.
- **HYGIENE — badge coverage: Golazos WIRED, All Day proven NOT portable.** Golazos badge feed was frozen at 2026-07-21; the reported blocker (610/610 NULL `edition_id`) was **not** unblocked by today's ownership fix (all 9,494 Golazos wmc rows have NULL `edition_key`) — but `sales.nft_id → sales.edition_id` resolves **426/610, 0 ambiguous**, so the blocker was resolution LOGIC. Shipped `resolve_golazos_listing_edition_ids()` (ambiguity-safe), `golazos_edition_floor_ask`, `refresh_golazos_badge_low_ask()`, and `cron.job rpc-golazos-badge-low-ask-refresh` (`10,40 * * * *`). Live: `edition_id` **0→426**, view **0→135 editions**, first tick `updated 34 / cleared 70`, feed newest row **07-21 → 07-25**. All Day's **584 of 6,190** missing badge rows are a **static 2026-04-12 seed residue**, and Top Shot's GHA catalog sweep **cannot** be ported: All Day badges come from Dapper Atlas, which WAF-blocks Vercel AND datacenter runners (hence the residential runner). **Deliberately did NOT backfill** — inventing badge rows is the same fabricated-data class as the pack-EV P0.
- **Operator step left open:** `evm-transfers-ingest` watchlist row muted (`is_active=false`) since the Beezie/Base plane was retired 2026-07-13 and all ~24 ticks/day return `no_active_contracts` — but the **schedule is a cron-job.org entry**, so only an operator can delete it. Dune crons/routes deliberately untouched (no watchlist rows, so no `cron_silent` noise; their 402 cap surfaces via the failure-count arm).

### July 25, 2026 (Claude Code, interactive — "implement a TODO" → bug hunt → the historical-sales gap) — 23505 batch data-loss eradicated across ALL 5 forward sales indexers · offers-sweep `::` map truncation · 2 anon-readable audit tables secured (sentinel) · the historical-sales gap MEASURED and its economics fixed

Task was "implement a straightforward TODO"; **every live-code TODO is gated, shelved, or already resolved** (Trade Hub's 5 stubs need the undeployed `RPCTradeEscrow` mainnet contract; Candy/Panini go-live TODOs are operator/editorial gates; `lib/chains/solana/normalize.ts` + lock-roi TODOs are `RESOLVED`-annotated comments; the 18 chain-rename shims were deleted 07-25). So the deliverable became real bug fixes. All to `main`, all 6 CI jobs green on the final tip, both deploys READY. Revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-25 entries).

- **`candy-sales-indexer` silently dropped NEW sales co-batched with a duplicate (`a6cda9ec`).** A `sales` batch insert is **all-or-nothing**: one duplicate `transaction_hash` (`23505`) fails the whole ≤100-row statement and writes NONE of it. The old branch swallowed the entire batch (`// dupes — already recorded`), so every co-batched new sale was lost — and because nothing landed, the DB high-water cursor never advanced past them, so the same dupe **re-dropped the batch on every tick = permanent loss**. Reachable via ME offset-pagination overlap and multi-item txns sharing a signature; Candy prints ~53 sales/24h, so the path is live. Fix: on 23505 fall through to the EXISTING row-by-row retry like every other error. Regression test pins a `[dupe, new]` batch (found=2, written=1).
- **`offers-sweep` `::` subedition map was truncated to 1,000 of 3,610 rows (`053dfe65`).** `fetchSubeditionMap` read the parallel editions with a bare `.limit(10000)` → PostgREST clamps to 1,000, so the `(play_id_onchain, subedition_id) → external_id` map was missing **~2,610 keys (~72%)**. An unmapped parallel is *skipped, never blended* (correct per the 07-07 contract), so those editions' top offer / lowest ask **never reached `edition_offers`** — and `badge_editions` holds 0 `::` rows, so the fallback was empty too: parallel edition/moment/grid pages showed no offer data at all, the exact display this sweep exists to feed. Fix: `.order("external_id").range()` pagination until exhausted (deterministic; mirrors `loadCachedMomentIds`). Sibling `fetchSetOnchainMap` left alone (250 `sets` rows, far under the cap).
- **The same 23505 batch-swallow was then found in FOUR more live writers and ALL were fixed the same session** (`allday-sales-indexer` + `ufc-sales-indexer` + `golazos-sales-indexer`, each on `sales` AND `unmapped_sales`, plus `sales-indexer` — the TopShot forward writer, whose variant was worse: it counted the whole batch `duped` with NO row-by-row retry, its fallback living only in an unreachable `catch`). **Lesson: the first sweep used `grep | head -20` and I reported the truncated list as complete — never make a completeness claim from a head-limited grep.** Pinned by a directory-driven source guard, `__tests__/sales-batch-insert-23505-guard.test.ts`. Verified NOT affected: `pinnacle-sales-indexer` (`.upsert` + `ignoreDuplicates`), and the `cron/*-sales-history-backfill` family whose positive-23505 branch IS the retry (correct — do not "fix").
- **Cleared a pre-existing `main` tsc red (`c2f53227`).** CI verification showed my two commits' own jobs all passing (vitest incl. new regression tests, DB-invariants, cadence×2, ledger-guard) but the blocking **TypeScript** job red — from 8 `__tests__/*-deep.test.ts` files added by concurrent coverage passes: the recurring `data: [] as any[]` mock-state field then assigned `data: null` (`TS2322`) + one missing `error` (`TS2741`). **Third occurrence in one day** (`72835ebe`, `d872110`). Fix: widen receiving fields to `data: [] as any[] | null` + add the missing `error: null`. Test-only.
- **SENTINEL — 2 hard smoke violations closed (`audit_20260725_secure_allday_residue_audit_tables`).** `audit_20260725_allday_v1_unsplittable_retag` (19,589 rows) + `audit_20260725_allday_unmapped_dedupe_tx_nft` had RLS off **and were anon-readable** (`has_table_privilege('anon',…)` true) — queryable at `/rest/v1/<table>` with the public anon key. The house pattern was measured, not invented: of 64 `audit_*` tables **62** already had RLS on with **zero policies** (deny-all; service_role/postgres retain access). RLS + per-role REVOKE in the SAME migration. Smoke `hard 37/38 → 38/38`, confirmed by a dispatched post-migration run.
- **THE HISTORICAL-SALES GAP — measured; the 23505 bug was NOT the cause.** `sales` = 4.56M rows, but **Top Shot alone holds 166,141 sales for 2021 (the mania year) vs 679,691 for 2023 (a quiet year) — 4.1×** (like-for-like TS-only; the raw 2023 *partition* is 1,209,696 but that includes AllDay/UFC/Golazos, so do not compare partitions directly); intra-2021 TopShot is inverted (Jan 74,969 → **Feb 27,552** → Mar 7,133). The 2020–21 V1 `Market.MomentPurchased` era is essentially absent. **Two blockers, in this order:**
  1. **`DUNE-DATAPOINT-CAP-402`** — `sales-ingest-dune` last succeeded 07-24 06:11Z; every tick since fails `HTTP 402 … exceed your configured datapoint limit per billing cycle`. **The entire month went in ONE day (07-24):** 4 runs pulled **581,664 rows** → **89.0% discarded** as edition-unresolvable, 9.8% already held, **only 1.2% (7,104) new sales** (+55,292 counterparty fills). Operator/billing — check the Dune cycle date + datapoint balance directly. **Also worth checking: datapoints bill as rows × columns and the ingest consumes only 6 fields (`tx_hash`/`nft_id`/`seller`/`buyer`/`price_usd`/`sold_at`); if saved query `8030177` returns more, trimming it cuts cost proportionally.**
  2. **Edition resolution.** The ingest resolves **only via `moments`**, which covers **702 of 106,559 (0.66%)** of the distinct TopShot nft_ids appearing in 2021 sales (`nft_edition_map` covers 33). That is the 85–90% miss, fully explained.
- **Fixed this session (DB-only, currently inert because Dune is capped):** (a) **cursor repositioned** — `sales_ingest_state.cursor_end` **2025-06-21 → 2022-01-01**, because the backward walker was grinding through our BEST-covered era (**2025: 612,219 TS rows already held**) and would have burned several more monthly budgets before reaching the 2020–21 hole; skips 2022-01→2025-06 (well covered), sweepable later. (b) **stop discarding** — new `public.sales_ingest_unresolved` (UNIQUE `(transaction_hash, nft_id)`, RLS on, anon revoked) and `apply_sales_ingest_external()` now **parks** unresolvable rows (+ a `parked` counter); deliberately NOT `unmapped_sales`, whose `check_unmapped_backlog_growth()` pages **'high'** at `open_rows >= 10000` (one Dune run parks ~140k). (c) new **`resolve_sales_ingest_unresolved(p_limit, p_dry_run DEFAULT true)`**, service_role only, pinned as DB invariant #20.
- **⚠️ DO NOT run `backfill_nft_edition_map_from_sales` for TopShot.** It is collection-parameterised so it looks like a drop-in, but it resolves conflicts **latest-sale-wins** (`DISTINCT ON (nft_id) ORDER BY sold_at DESC`) — safe on AllDay ONLY because AllDay has **0 ambiguous** nft_ids (re-verified: 0 of the next 5,000, so pg_cron jobid 215 is fine). **TopShot has 287 ambiguous nft_ids in the 2021 partition alone**, and sampled cases are cross-set **MISATTRIBUTION**, not the benign `::` parallel re-key (`nft_id 102839` appears as both `134:5038` and `5:12` on the same day; `107831` as both `29:584` and `5:50`). Latest-wins would bake a wrong edition into `sales` → into FMV. Use the ambiguity-safe path (`count(DISTINCT edition_id)=1` only). It also only drains `unmapped_sales`, which the Dune path never populates — so **parking is a prerequisite, not an optimisation**.
- **Also confirmed clean (no bug):** `lib/rtr-lock-roi-weights.ts` + lock-roi's `fmv_current` chunked read, `lib/chains/solana/normalize.ts`/`das.ts`, `lib/format.ts`, `lib/analytics/rpc-with-retry.ts`, the wallet-backfill chunk tally, `scripts/smoke-gate.py`. **Left deliberately:** `lib/market-sources.ts` (the queued FMV-adjacent `MARKET-SOURCES-FMV-RECENT-WINDOW-CAP`, do-not-auto-ship), `app/api/pack-listings/historical-pulls/route.ts` (truncates to an arbitrary 1,000 with no `.order()`, but **zero in-repo callers** — dead; a real fix is a redesign), and candy-sales-indexer's boundary `<=` (a naive `<` would re-fetch DAS assets for already-recorded boundary-second sales every tick, burning the asset-fetch budget — net worse).

### July 25, 2026 (Claude Code, interactive — late UI/display/route/CI-repair wave + deep test-coverage passes) — the tail of the 07-25 day: `/pinnacle/*` un-branded, dead Smoke-Tests gate repaired, display-correctness batch, pack "What's Inside" spinner + IPFS image-weight fixes, 55 pre-existing tsc errors cleared (main was red), coverage ratchet pushed to 78.8/64.5/84.3/81.4

The interactive fixes and coverage passes that landed on `main` after the edge-drift audit below, all with revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-25 entries). Mix of user-facing correctness fixes and test-only ratchet work; no migration, no `vercel.json`, no pricing/FMV/EV logic touched.

- **`/pinnacle/*` was rendering Disney Pinnacle data under NBA Top Shot branding — FIXED (`73b722f8` + one-hop follow-up `9d4ce49e`).** `pinnacle` is NOT a registered slug (canonical `disney-pinnacle`), but `app/(collections)/[collection]/*` still matched `/pinnacle/<tab>` (only `app/pinnacle/` `page`+`moment/[id]` exist), so `getCollection("pinnacle")→undefined` made the layout fall back to the first published collection's chrome + the generic title while pages fetched real Pinnacle rows. Added an **explicit page-allowlist 308** in `next.config.ts` → `/disney-pinnacle/...` (deliberately NOT a blanket `/pinnacle/:path*` — `/pinnacle/moment/<render_id>` is a real page with ~2,412 sitemap URLs). Split into a bare-tab rule + `/:rest+` rule so it's a **single hop** (the naive `:rest*` compiled an empty rest to a trailing slash → a second 308). Pinned by `__tests__/next-config-pinnacle-redirect.test.ts`.
- **The Smoke-Tests CI gate was structurally DEAD (`a36ca981`).** `smoke-tests.yml` read a `failed` key `/api/smoke-test` has never emitted, so the failure branch was dead code and the job was green on ~3,072 runs regardless — masking a live `check_public_security_invariants` hard failure. Moved to `scripts/smoke-gate.py`: fails on `hardPassed != hardTotal`, on any non-soft failing result, on an unparseable body, and **when any expected key is ABSENT** (a detached gate must fail loudly). Route keys pinned by `__tests__/smoke-gate-contract.test.ts`.
- **Display-correctness batch** (`80ca5051` + `45043f77` + `3056a787`): shared **`humanizeLabel()`** in `lib/format.ts` kills raw-enum leaks (`IN_SEASON_PREMIUM`→"In Season Premium" on the Golazos pack title/OG/tier chip — CSS `capitalize` doesn't treat `_` as a word boundary); shared **`dedupeLabelParts()`** removes duplicated Pinnacle studio/effect strings; TS edition holder wording made honest ("hold 249 of its 284 moments (indexed holdings, a lower bound)"); **React #418 SSR hydration mismatch** on relative timestamps fixed with new `components/entity/RelTime.tsx` (stable placeholder → fill after mount) in the two CLIENT render sites; `/insights/candy-mlb` **confidence pills purged** (no-confidence-UI policy — the `confidence` field still rides the payload as data, not display) and `usd()`/`num()` pinned to `"en-US"`; the 4 indexable analytics success-path titles dropped their baked-in brand so `lib/seo.ts`'s `title.template` supplies it once.
- **Pack "What's Inside" infinite spinner BOUNDED + entity hero IPFS-master image weight (`7c0a0d5f`→`66afafc3`, `a3dc001f`).** The pack "Loading pack contents…" spinner was NOT a data problem (`get_pack_contents` returns 24 rows in 67 ms; the full page renders server-side) — the decisive finding: **React does not hydrate the fallback of a dehydrated `<Suspense>` boundary**, so a watchdog inside the fallback can't work; the content is now rendered in the shell. Separately, entity hero/team montages were painting 4 MB IPFS master images into 72px tiles (~1,460× oversize) — bounded + player-portrait masters deferred with reserved layout.
- **`main` was RED on the blocking `typecheck` job — cleared (`72835ebe`).** Pristine `origin/main` had **55 pre-existing `tsc --noEmit` errors**, all in `__tests__` `vi.fn` mock declarations (zero-arg `vi.fn` inferring empty parameter tuples, etc.); test-only, no product code.
- **Deep test-coverage passes (test-only).** Drove flagship `sniper-feed` 8.8%→35% branch (handler contract + real AllDay compute), the 2 fetch-based backfill routes (`backfill-onchain-ids`, `pinnacle-ingest`) to ~90% branch, and a ~85-branch dent on the 1,407-branch `support-chat` concierge (honesty-critical input guards). **CI ratchet raised across the session to 78.8 stmts / 64.5 branch / 84.3 funcs / 81.4 lines** (live actual ~79.4/65.1/84.9/82.0; suite ~811 files / ~5,576 tests) — kept a ~0.5 buffer under actuals.

### July 25, 2026 (overnight pass) — GENUINE OVERNIGHT (~01:02 PDT, no skew); shipped 1 (get_team_activity 28s→~60ms DB rewrite, subagent PASS); post-ship watch of the 07-25 mega-wave ALL PASS; candidate 2 already-resolved; health GREEN

Fired in-window (shell 08:02:19Z ≈ DB now() 08:02:22Z ≈ newest sale 07:56Z — no skew). Push available, no FREEZE. `origin/main` advanced `ee63eab8`→`dd1127a5` mid-run (a concurrent CC pack-EV-edge/atob/wallet-backfill batch — different surface, no overlap; my DB change + docs rebased on top). Shipped **1** (DB-only), reverted 0, repaired 0, closed 1, drained 4 inbox files. Handoff: [docs/handoff-2026-07-25-overnight-pass.md](docs/handoff-2026-07-25-overnight-pass.md).

- **SHIPPED — `audit_20260725_get_team_activity_soldat_ordered_rewrite` (DB-only, no deploy).** `get_team_activity` (behind `/[collection]/team/[slug]` + `/api/entity/team-activity`) ran **~28 s** on a large team, holding a service_role pool connection to the 30 s ceiling → "Timed out acquiring connection from pool" (Sentry NEXTJS-1Y, the 0308Z inbox candidate). Its `JOIN sales→editions` + `ORDER BY sold_at DESC LIMIT 30` **gathered every team sale (~60k–120k rows) then top-N sorted**; the fn's own `SET statement_timeout='8s'` is inert on the direct-call path (documented re-arm finding). Fix: materialize the team `edition_ids`, scan `sales` via the EXISTING per-partition `(collection_id, sold_at DESC)` indexes with `edition_id = ANY(...)` → MergeAppend walks newest-first and **stops at the LIMIT** (no new index). **28,168 ms → 58–129 ms.** Byte-identical row selection PROVEN (0 rows where `sales.collection_id` ≠ edition's; multiset diff 0/0 across 4 arg sets; the md5 diff was pure equal-`sold_at` tie-order, already nondeterministic in the original). Attributes/ACL preserved. Independent subagent PASS. **Revert:** restore the prior JOIN-then-gather body (full body in the handoff).
- **CLOSED 1** — 0605Z candidate `audit_20260725_allday_nem_from_sales` RLS-off/anon-readable: ALREADY RESOLVED (RLS on, anon/authenticated SELECT revoked, `rls_off_base_tables` `[]`); do NOT drop (same-day revert artifact). Also the 07-24 Candy-view `security_invoker` invariant (2→11 views) self-cleared (`security.invariants []`).
- **Post-ship watch of the 07-25 mega-wave: ALL PASS, 0 reverts.** P1 legacy-wmc-unique-index DROP healthy (wallet-backfill 480 / allday 575 / pinnacle 561 ok, **0 fails/24h**); 4 pg_cron `cron_heavy` moves (216–219) all succeeded; jobid 215 nem-backfill ok; new crons allday-price-recover 14/0 + resolver-tail 1/0.
- **Health GREEN.** security 0/0/0/0; trust 20 metrics 0 breaches; stalled `[]`; pg_cron `[]`; sentinel 0; Sentry 0 unresolved/24h; Vercel prod `9d4ce49e` READY (3 docs-only tips correctly CANCELED), 0 ERROR; DB 10,779 MB.

### July 25, 2026 (Claude Code, interactive — edge-fn repo↔prod drift audit) — pack-EV writers were repo-BEHIND-prod on `typical_ev` (deploying would have silently blanked a shipped display); all 3 `atob` mojibake WRITERS fixed; wallet-backfill upsert-chunk data loss made visible

Repo-only pass, all to `main`. **No migration applied, no edge fn deployed, no `vercel.json` touched.** `tsc --noEmit` 0 errors; full suite **802 files / 5,496 tests, 0 failures**. Revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-25 entries). Deploy handoff: [docs/handoff-2026-07-25-pack-ev-edge-deploy.md](docs/handoff-2026-07-25-pack-ev-edge-deploy.md).

- **PACK-EV EDGE DRIFT — the repo was simultaneously AHEAD and BEHIND production, and a deploy would have regressed it silently.** `pack_ev_history.typical_ev` ("Typical Pull EV" = slots × supply-weighted MEDIAN FMV; live on the pack page + `/packs` via `mv_pack_ev_latest`→`pack_table_rows`) was added to the AllDay/Golazos/Pinnacle writers on 2026-07-18 **via the Supabase MCP, which does not touch git**; commit `fb7eb0f2` (07-20) then refactored the *older* bodies onto `_shared/pack-ev-supply-weighted.ts`. Measured live via `get_edge_function`: **allday** deployed v29/internal-v9 vs repo v8, **golazos** v6/v2 vs v1, **pinnacle** v8/v2 vs v1 — none of the three repo copies contained `typical_ev`. **`compute-topshot-pack-ev` is byte-identical** (v43/v23, md5 `5133101c08413e80a1b53662a870d6ca`) — never part of the `_shared` rewire, so **do NOT redeploy it**. Repo reconciled to a behavioural SUPERSET with deployed as the source of truth — **no weighting/threshold/clamp/rounding changed**; median semantics confirmed against the live SQL (`min(fmv) WHERE cw >= 0.5*tw`, `round(…*slots,2)` clamped `[0,1e6]`). **DURABLE: an MCP edge-fn deploy creates git drift by construction — always follow it with a repo commit of the same body, or the next repo-based deploy silently reverts it (this has now bitten `compute-allday-pack-ev` twice: 07-01 v8, 07-18 v9). The dangerous direction is repo-BEHIND-prod; repo-ahead is benign.**
- **The guard class that let it happen.** The existing drift test compared **repo↔repo** (edge fn vs `_shared`), so a refactor that DROPPED a field was invisible. New directory-driven guard (globs `compute-*-pack-ev`, covering future collections automatically) asserts each writer persists `typical_ev` as a real payload key fed from `typical_pull_ev`/`typicalEv`; **proven to bite** by deleting the field and watching CI redden. +12 median unit tests. **Rule: guard the PROPERTY (does this writer persist this field?), not just the CONSISTENCY (does the copy match the module?).**
- **`atob` mojibake WRITERS fixed — all 20 call sites under `supabase/functions/` audited, 3 were live writers.** `atob` is latin1-only, so a base64 UTF-8 payload double-encodes. `seed-allday-pack-distributions/index.ts:89` is the SINGLE decode site feeding both `title` and `metadata` (and seeds BOTH Golazos and AllDay via `?collection=` — why Top Shot/Pinnacle had 0 corrupt rows); today's `audit_20260725_pack_dist_*_mojibake_*` migrations repaired 216 rows but the writer would have re-corrupted. Two MORE found: **`topshot-stub-resolver`** (writes `p_player_name`/`p_set_name`/`p_team` — **846 TS editions already hold non-ASCII**, Dončić/Jokić/Şengün class) and **`enrich-ufc-wallet`** (writes `wmc.player_name`). Both prospective, not already-corrupt. Pattern ported from the pre-existing `scan-pinnacle-wallet/index.ts:24-30`; **no-op for pure-ASCII payloads**. 16 SAFE (ids/addresses/serials/heights/closed slugs) — notably `scan-ufc-wallet` only `slugify()`s its decoded name so mojibake collapses identically, and `ufc-stub-thumbnail-resolver` is the lone borderline (decoded `thumbnail_url`, all rows ASCII, left alone). **All 3 fixes are repo-only — NOT deployed;** safe because the seeder has written nothing in 15+ days.
- **Wallet-backfill upsert-chunk failures were silent DATA LOSS.** All four `upsert_wmc_batch` chunk-error branches in `lib/chains/flow/wallet-backfill-helpers.ts` (+2 in `app/api/wallet-backfill/route.ts`) `console.error`'d and continued with **no counter, lost rows absent from `rows_skipped`, and `ok: true`** — 3,497 runs reported 0 failures across a window dropping ~37 chunks of ≤200 rows. The paginated path's `chunkErrors` counted only PAGINATION-fetch failures, so an upsert failure was invisible on BOTH counters. Extracted one shared `upsertWmcChunks()` + `ChunkFailureTally`; a failing chunk still doesn't abort the loop (partial progress banked) but now sets `ok=false`, folds `chunk_rows_lost` into `rows_skipped`, and writes `extra.{chunk_errors,chunk_rows_lost,first_chunk_error}` + a `pipeline_runs.error` string. Shape mirrors `app/api/cron/ufc-enrichment-drain/route.ts:293-310`. **Pagination-fetch tolerance deliberately unchanged** (those rows were never fetched). **An existing test PINNED the bug** — `"survives an upsert RPC error (logs ok, written stays 0)"` asserted `p_ok === true`; rewritten, +5 new cases across all four helper paths and the route.
- **Ledger gap closed:** diffing `supabase_migrations.schema_migrations` (31 migrations dated ≥ `20260725`) against the ledger found **5 that reached prod with no entry** — `pack_ev_require_drop_pool` (P0: Pinnacle was publishing a $2,651 EV on a $4.99 pack; now 1,001 EV rows publish, Pinnacle 0), `pack_ev_suppress_sentinel_price_and_thin_coverage` (dist 5730 published `gross_ev` $900,000 on 3% coverage), `secure_internal_audit_tables`, `trust_health_fmv_coverage_staleness_legs` (**`v_rpc_trust_health` is now 20 metrics, not 15** — 5 new `<collection>_fmv_pct_stale_30d` COVERAGE legs; TopShot baseline 32.3%), `badge_editions_collection_denorm_fix`. All recorded retroactively with revert paths derived from each migration's own header + a live post-state check.

### July 25, 2026 (Claude Code + Cowork, interactive — AllDay unmapped-residue recovery, detail-page perf + Sentry hardening, Candy QA, security-guard + big test-coverage/DB-pin push) — the AllDay residue day: 2,619 sales reclaimed free + self-heal cron, pack-detail RPC 1.1s→27ms, anon-write guard, coverage ratchet 76.3→77.6 / DB pins 13→19

A full day of Trevor-directed interactive work on top of the 07-24 Candy day, all to `main` with revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-25 entries). The daytime monitor + night pass had been dormant 07-22→07-24 (app closed), so the weekly `rpc-data-quality-sweep` was the first eye on the AllDay residue.

- **AllDay `unmapped_sales` residue — REFRAMED, then drained across 3 phases.** The 44k backlog the weekly sweep flagged (+39,935/7d) is NOT a regression — it's the expected unresolvable **residue** of a *succeeding* `allday-sales-history-backfill` (walking backward, ~64% done, already promoted **612,553** deep-history sales / 4,399 editions back to 2022-11-03). The dominant blocker is **edition resolution** (not price): of ~41,853 distinct residue nfts only ~456 were in `nft_edition_map`. No live impact (unpromoted rows never reach `sales`; AllDay FMV fresh). **Phase 1 (DB-only, shipped):** an AllDay NFT's edition is immutable, so a residue nft that re-sold later already carries its edition in `public.sales` (verified **0 ambiguous**) — backfilled `nft_edition_map` from `sales` (**8,025 rows**, `audit_20260725_allday_nft_edition_map_from_sales`) → `promote_unmapped_sales` drained **2,619** real historical sales with ZERO on-chain calls. Durable self-heal: SECDEF `backfill_nft_edition_map_from_sales(collection_id, limit)` + **pg_cron jobid 215** `rpc-allday-nem-from-sales-backfill` (`cron_heavy`, `*/30`). **Phase 2 (code):** `allday-price-recover` — rewrote `/api/admin/recover-v1-budget-exhausted` from an `after()` one-shot into a standing SYNCHRONOUS drainer (re-decodes `v1_tx_decode_budget_exhausted` rows via `decodeV1SaleTx`, DUC=USD, patches price + promotes), Vercel cron `*/20`. **Phase 3 (code):** `allday-unmapped-resolver-tail` (new `/api/cron/allday-resolve-unmapped-tail`) targets the OLD (>7d) edition-unknown residue the live resolver skips; bounded 90 attempts/tick, **expected LOW yield** (old moments moved to non-borrowable state), Vercel cron `40 */3`. Dominant tail is absorbed for free by jobid 215 as moments re-sell.
- **Detail-page perf + Sentry fix — the recurring connection-pool 500s.** Root cause of the `get_pack_detail_bundle` timeouts: the #1 total-time RPC (2,254 calls, ~1.1s mean, 29s tail) joined `editions` and ran the rep-nft `wmc` lookup for ALL ~1.5k pool editions before taking top-5 by FMV. Rewrote the hero block (`audit_20260725_get_pack_detail_bundle_hero_fast`): score FMV once/edition in a MATERIALIZED CTE, join `editions`+rep-nft **only for the final 5** — **warm 1.1s → 27ms (~40×), output byte-identical across 29 dists**. Separately taught `lib/analytics/rpc-with-retry.ts::isTransient` the pool-acquire phrases ("Timed out acquiring connection from connection pool" — "timed out" ≠ the "timeout" substring it matched) and wrapped the primary fetch on player/team/pack detail pages in `rpcWithRetry` (3 attempts + backoff).
- **Candy QA drain.** (1) **Perf blocker (HIGH):** the FMV-heavy candy boards joined the global `fmv_current` (`DISTINCT ON … FROM fmv_snapshots`, no collection filter) 2–3× per render, materializing the whole ~896k-row `fmv_snapshots_2026` partition each time — shipped candy-scoped view `candy_fmv_current` (`audit_20260724_candy_scoped_fmv_current`) and repointed all 5 candy views; EXPLAIN cost e.g. `candy_secondary_board` **163,303→571**, output identical. (2) **Troll-ask floor guard (K=10)** on `candy_listing_floor` + boards. (3) Banner honesty P2: no longer claims "every price LOW off 1–2 sales" (live: 78 LOW + 3 MEDIUM). All new candy views anon/authenticated-REVOKED, `security_invoker=on`, `check_public_security_invariants() []`.
- **TS pack subpage (frontend-only).** Killed the lifecycle strip that contradicted headline counts — for Top Shot the `pack_rips` bridge only attributes ~20% of opens, so relabeled TS lifecycle `complete open history` → `attributed rips · sample` and gated the "Opened share 100%" cell on `lcDepletionAuthoritative` (AllDay only); honest no-pool empty state for the 1,521/2,031 TS dists with no drop pool.
- **Security — anon-WRITE guard (the sneakier hole).** The smoke test's `check_public_security_invariants()` only caught RLS-*off* tables, missing RLS-on + anon write grant + a permissive no-auth policy. New SECDEF `check_anon_write_surface()` (`audit_20260725_check_anon_write_surface`) flags exactly that class outside a bounded allowlist (returns `[]` now), wired into `/api/smoke-test`, and pinned as the 19th DB-invariant.
- **Concierge — `check_wallet` gained `standing_best_offer_total_usd`.** New collection-agnostic SECDEF `get_wallet_best_offer_total(p_wallet)` (max live DapperOffersV2 bid per held moment across all collections from `marketplace_offers`), wired in defensively (try/catch → omit field on failure) as a **bid signal, never FMV**.
- **Test-coverage + DB-pin push (test-only, behavior-preserving).** Ratchet raised **76.3/61.45/82.0/78.9 → 77.6/62.9/83.3/80.1** over the day (live actual ~78.1/63.5/83.9/80.7; suite ~793 files / ~5,398 tests). Method: drove the DEFERRED `after()` bodies of **8 cron routes** for the first time (alerts-dispatch, refresh-serial-fmv-multipliers, refresh-conflated-editions, backfill-pack-rip-metadata, refresh-pack-grail-metrics-mv, snapshot-pack-asks, run-insider-detectors, pinnacle-wmc-render-id) — pinning the **silent-run** legs (a dispatcher/work-RPC throwing while the run logs ok:true) that the 2026-06-10/06-11 dark-run incidents exposed. Also extracted fmv-recalc's 8 FMV price-math primitives verbatim to `lib/fmv-recalc-math.ts` (+40 tests) and fixed a pre-existing `main`-red (smoke-test deep probe counts drifted after the anon-write assertion). DB-invariant pins **13 → 19** (+`check_anon_write_surface`, `panini_serial_premium_mult`, offer RPCs, FMV serial-estimate).
- **Cowork — cold-signup reminder infra shipped INERT.** New read-only SECDEF selector `get_cold_signup_reminders` + gated cron route `/api/cron/signup-reminder` + email template, all dormant (sends nothing until `SIGNUP_REMINDER_ENABLED=1` + a cron entry). Onboarding-funnel diagnosis: **retention is the real leak — 0 WAU**; weekly-digest / alerts / funnel instrumentation were already built inert and verified flip-ready.

### July 24, 2026 (Claude Code, interactive daytime — Candy chain-two productization + parity build, RTR lock-ROI v2, test-coverage pass) — the big Candy day: FMV validated, ask feed shipped, first gated `/insights/candy-mlb` board + 10 gated views live (all anon-revoked); RTR playoff-points estimate now tier+serial-weighted; +46 tests / +1 DB pin

A full day of Trevor-directed interactive work on top of the overnight pass below, all to `main` with revert paths in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-24 entries). See the updated Chain-strategy Candy paragraph above for the full surface list.

- **Candy productization (Item 1–3).** Confirmed Candy FMV needs no rewrite — it's already computed by the collection-agnostic `fmv-recalc` (algo `1.7.0`, 46/125 priced, LOW-confidence; 79 zero-sale editions stay honest FMV-`—`, best-offer kept as a SEPARATE offer-floor column never folded into FMV). Shipped views `candy_secondary_board` + `candy_pack_ev_model` (Actual EV ~$86 vs **Typical Pull median ~$26** — board leads with Typical Pull) and the first gated public board `app/insights/candy-mlb/*` + `/api/public/insights/candy-mlb`, walled by a NEW `proxy.ts` line (`/insights/candy` + `/api/public/insights/candy` — Candy wasn't previously route-gated). `noindex`; `candy_mlb` stays `is_active=false`; board reads Candy directly (no `is_active` flip, no shared-RPC candy-arm needed).
- **Candy↔Top Shot parity build (Items A–E).** The structural blocker was **no ask feed** — shipped `candy_listings` (PK `pda_address`) + `candy_listing_floor` + route `candy-listings-indexer` (Vercel cron `35 */3 * * *`, a Next.js route NOT a worker) mirroring `candy-offers-indexer`. Then 8 gated aggregation views (scarcity/holders [246 collectors, treasury excluded via a dynamic max-holder helper, never hardcoded]/special-serials [500 rows]/parallel-player [Core ~$5.70 vs Rainbow ~$170, ~30×]/deals/offer-spread) + a tabbed board (Market·Deals·Spread·Serials·Scarcity·Holders·Players), each carrying honesty banners (thin/LOW, sealed-vs-circulating, best-offer≠FMV, Rainbow multiple = early signal). **Follow-up same day: `candy-listings-indexer` ME page-size fix** (`ME_LIMIT` 500→**100** — ME caps `limit` low, 500→HTTP 400 so every tick was failing in ~250ms; `MAX_PAGES` 40→100). **Every new Candy table/view is anon+authenticated SELECT-REVOKED** (verified `has_table_privilege` false, service_role RW). Cowork normalized the 11 `security_invoker=true` Candy views to `=on` (`audit_20260724_candy_view_invoker_normalize`) so `check_public_security_invariants()` returns `[]`.
- **RTR lock-ROI playoff-points estimate v2** (`app/api/rtr/lock-roi/route.ts`). v1 was `floor(fmv/10)` — a flat 1/10 points-per-dollar that made the board sort by integer-floor rounding noise and zeroed every sub-$10 moment. v2 scales the FMV base by an ordinal **tier** weight (`COMMON 1.0 … ULTIMATE 6.0`) and a bounded **serial-scarcity** factor (`1 + 0.25·e^(−serial/250)`, [1.0,1.25]), computed unrounded so cheap moments keep a real ratio. Weights are documented interim heuristics pending empirical Run-2 calibration; +3 regression tests. Implements the standing `TODO(lock-roi-calibration)`.
- **Test-coverage pass (test-only, behavior-preserving; suite 754 files / 4667 tests, +46 new, 0 regressions).** New `__tests__/invariants-postgrest-cap.test.ts` (7 tests) pins each already-fixed PostgREST-1000-cap incident site (`fmv_current` reads, `count`+`head:true`, `.range()` paging, sets-db accumulator `.set()`-back) so none can silently revert. +1 DB-invariant pin **`check_email_allowed`** (the login front-door gate; 11 assertions: open-by-default, revoked/deny_list exact+domain+expired, case+trim) → pins 12→13, and hardened the drift-guard extractor to skip `--`-commented `CREATE` lines. Pinnacle mint/deposit CDC decoders extracted to `_shared/pinnacle-mint-parse.ts` + byte-parity source-drift guard (edge fn source unchanged). Also lifted `MarketplaceStatusBanner`/`TrophySlab` logic to `lib/` for component-layer coverage. **Live coverage baseline: 76.51 stmts / 61.69 branch / 82.21 funcs / 79.15 lines.**

### July 24, 2026 (overnight pass) — OFF-HOURS / MONITOR-MODE (~07:05 PDT, no skew); shipped 0 (correct); post-ship watch of the 07-20/21 wave ALL PASS; health GREEN (0 breaches); autonomous system dormant 07-22→07-24

Fired ~07:05 PDT (14:05Z) — OUTSIDE 00:00–06:00 ⇒ monitor-mode (full triage + post-ship watch, queue don't ship, docs-only). No skew (shell 14:05:12Z ≈ DB `now()` 14:05:33Z ≈ newest sale 14:03:08Z ≈ newest FMV 13:54:22Z). Push AVAILABLE, no FREEZE. **`origin/main` `99f3bd9f` UNCHANGED start→end — nothing pushed to `main` in ~3 days; the daytime monitor + night pass have been dormant 07-22→07-24 (app closed).** Mount is 13 commits behind at `26727e97` (07-20 eve) — no divergence, no unpushed mount work; the 4 stale mount-inbox files are already in origin's archive. Shipped **0**, reverted 0, repaired 0, closed 0. Handoff: [docs/handoff-2026-07-24-overnight-pass.md](docs/handoff-2026-07-24-overnight-pass.md).

- **Ship 0 was correct** (all connectors live, push available): off-hours ⇒ queue-not-ship, and independently there was no new ship-worthy candidate (no incremental monitor inbox during the gap) and no regression to auto-revert.
- **Post-ship watch of the 07-20/21 wave: ALL PASS, 0 reverts** (soaked 3+ days). `audit_20260721_watchlist_allday_listings_indexer` row intact; `detect_stalled_pipelines() []`; covered pipeline healthy (8 runs/2h, last 14:02Z). Security wave holds — anon revokes false on `pro_users`/`user_profiles`/`pack_table_rows`; `check_secdef_anon_exec_drift() []`; `get_pipeline_alerts()` executes after its drift-arm rewrite. Vercel prod `99f3bd9f` READY, 0 ERROR.
- **Health GREEN.** security 0/0/0/0 (+ secdef-drift [] + pg_cron clean); trust **15 metrics, 0 breaches**; `stalled_pipelines []`; sentinel_ts_uuid_48h **0** (was 24); unmapped_backlog 22. DB **10,804 MB** (+411 over ~3.25d, normal). editions TS 19,506. **FMV TS H+M 3,293→3,051** (−242; FMV is fresh — topshot_fmv_stale 0h, sanity 0 — documented redistribution/oscillation, not a stall). **Traction: 20 users, 0 new signups since 06-10** (front door open since 07-20, no walk-throughs); funnel firing (10 events/24h). Sentry 2 unresolved, both carried-class (player-detail pool timeout + a 1-event sales-indexer blip). Artifacts 17/15, none broken/repaired.
- **Follow-up (Trevor-directed, same session) — FIXED the one real failure.** `snapshot-institutional-wallets` had been ok=false 2 days on the NBATopShotCommunity mega-wallet's TS diff (`compute_institutional_wallet_diff` looped per-arrival — 6,535/day — with an `EXISTS` that scanned all 24,518 of the buyer's `topshot_insider_buybacks` rows for lack of a `moment_id` index). Shipped additive index **`idx_topshot_insider_buybacks_buyer_moment (buyer_address, moment_id)`** (live CONCURRENTLY + parity migration `20260724143620_audit_20260724_...`) → RPC **>150s → 388 ms–4.07 s**; independent subagent **PASS 5/5**; revert `DROP INDEX IF EXISTS public.idx_topshot_insider_buybacks_buyer_moment;`. The healing run caught the wallet up (buybacks 24,518→31,053). Remaining real failure is the **Dune pair** (HTTP 402 datapoint cap — operator/billing, DUNE-DATAPOINT-CAP-402); all other `pipeline_fails` are self-recovering contention-class.
- **Then (Trevor: "keep going" on contention) — SHIPPED the #1 IOPS hog fix.** `claim_sales_counterparty_batch` was the top `pg_stat_statements` disk reader (186.8M reads, mean ~39s, timing out) — a runtime-cursor claim that seq-scanned all 8 `sales` partitions and sorted ~1M rows/call. Shipped **6 partial indexes `idx_sales_<2020..2025>_nullseller_soldat (sold_at DESC) WHERE seller_address IS NULL`** (live CONCURRENTLY one-at-a-time + parity `20260724150000_...`) → range-partitioned ordered-append, **~39s→546 ms warm, ~19x fewer disk reads**; `sales_2026` (active-ingest) left unindexed to avoid write-amplification; independent subagent PASS; revert drops the 6. **FLAGGED (not fixed): CANDY-VIEW-SECURITY-INVARIANT-DRIFT** — `check_public_security_invariants()` []→2 (`view_unexpected_definer` on `candy_pack_ev_model`+`candy_secondary_board`, new Candy views); SAFE (security_invoker, not anon/authed-readable), needs owner allowlisting. Queued `refresh_seeded_wallet_stats` (highest total-time consumer; cost is `holdings_summary()`, not an index gap).

---

### Older sessions

Archived to `docs/sessions/` (newest-first within each file):

- `docs/sessions/2026-07.md` — July 21 → July 1 (overnight passes + daytime CC; sales-counterparty/Candy/Panini readiness, Pack-EV accuracy program, IOPS read-diet, Trophy-case PDF, test-coverage infra, platform audits).
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

The `[collection]` dynamic segment serves all 5 published collections: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike. Each collection's page set is its `pages: [...]` array in `lib/collections.ts`, but since the **2026-07-18 IA reorg** the TOP BAR renders `tabBarPages()` = `pages` minus `TAB_BAR_HIDDEN_PAGES` (`packs`, `pack-sniper`, `hot-floors`, `challenges`) — those stay registered pages so every gate, capability check, and collection-switch keeps working; only the tab bar hides them. Per-collection `pages` (verified 2026-07-18):

- **All 5 published:** `overview`, `collection`, `sniper`, `analytics`.
- **`market` + `packs`:** all except UFC (Pinnacle gained both in the IA reorg).
- **`sets`:** all except Pinnacle.
- **`pack-sniper`:** Top Shot + AllDay only.
- **`challenges` + `hot-floors` + `play`:** Top Shot only.

**How the folded pages are reached (IA reorg conventions):** the **Moments | Packs sub-toggle** (`components/collection/PackSubNav.tsx`) mounts under the Collection / Market / Sniper tabs and is URL-param driven — `?section=packs`, NOT nested routes, so sub-views stay deep-linkable and the parent tab keeps highlighting (the market page already owns `?view=` for grid/table, which is why the toggle uses `?section=`). "Moments" is relabeled "Pins" for Pinnacle. Top Shot's `play` tab is the **Play hub** (`play/` route dir) fronting Challenges, Fast Break, and Road to the Ring. `components/collection/FeatureTabGate.tsx` (used by `market/layout.tsx` + `sets/layout.tsx`) gates those routes for collections that don't list the page.

**Market vs Sniper split (Trevor, 2026-07-18): Market is EDITION-level (one row per edition; AllDay via RPC `get_allday_market_editions`; Pinnacle via the render-keyed live-listings source reusing `computePinnacleSniperFeed`), Sniper is SERIAL-level (individual listings).** Market defaults to Price ascending.

Top Shot's Fast Break and RTR (Road to the Ring) game features live at `fast-break/` + `road-to-the-ring/` route dirs — still not registry tabs themselves (they appear in no `pages` array; the `play` hub links to them). Entity/detail routes under `[collection]` (also not tabs): `edition`, `moment`, `set`, `series`, `player`, `team`, `pack`, `profile`. There is NO standalone `badges` tab — the page type lingers in `lib/collections.ts` but no collection lists it and `/[collection]/badges` 307-redirects to `/overview` (badges render inline on edition/moment pages via `get_edition_badges_unified`).

Other top-level surfaces:
- `/share/[wallet]` — shareable collection card with OG image
- `/profile/[username]` — public profile, served from `/api/public/profile/[username]`
- `/analytics` and `/analytics/wallets/[address]` — analytics dashboards. Source lives under the `app/(analytics)/` route group (the group name doesn't affect the URL, so `find app/analytics` misses it). Sibling dashboards: `/analytics/{sales,loans,fmv,packs,sets,pulse,listings,methodology,api}`. Distinct from the per-collection `analytics` tab at `/[collection]/analytics`.
- `/admin/*` — internal tools incl. `/admin/flowty-analytics` (RPC_ADMIN_TOKEN gated)

Selected API endpoints worth knowing about:
- `/api/edition-stats`, `/api/pack-roi`, `/api/collection-snapshot`, `/api/overview-stats`
- `/api/admin/prune-pipeline-runs` (POST, Bearer `$INGEST_SECRET_TOKEN`; daily cron)
- `/api/wallet-backfill[-allday|-pinnacle|-golazos|-ufc|-multicollection]` — fire-and-forget Cadence walks; `?force=true` to bypass `skip_cached`
- `/api/seed-wallet-refresh` — orchestrator; cron-job.org still calls every 6h but an in-route gate (2026-07-18 cost lever) executes only the `utcHour % 12 < 2` waves (effective 12h cadence). `?force=1` bypasses (used by the GHA backstop — load-bearing, do not drop); env `SEED_WALLET_REFRESH_EVERY_WAVE=1` disables the gate

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
npx vitest run __tests__/some-file.test.ts   # run a single test file
npm run test:coverage    # same suites + coverage ratchet (what CI gates on)
npm run test:cadence     # extract inline Cadence + `flow cadence lint` the fixtures
npm run test:cadence:escrow  # RPCTradeEscrow `flow test` suite (fetches deps first; NOT in CI)

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
- `app/api/support-chat/route.ts` — AI concierge (29 tools, Claude Sonnet — model `claude-sonnet-4-6`, verified 2026-07-16)
- `proxy.ts` — site lockdown (Next.js 16 convention, replaces middleware.ts; hardened May 8)
- `workers/topshot-proxy/` — Cloudflare Worker. Routes: POST / or POST /topshot → public-api.nbatopshot.com/graphql, POST /allday → public-api.nflallday.com/graphql, POST /allday-consumer → nflallday.com/consumer/graphql.
- `workers/odds-proxy/`, `workers/sports-proxy/` (deploys as `rpc-sports-proxy`), `workers/hybrid-custody-proxy/`, etc. — see the Cloudflare Workers table below for the full list + per-worker auth. `hybrid-custody-proxy` uses `INGEST_SECRET_TOKEN` Bearer; the others use `TS_PROXY_SECRET` via `X-Proxy-Secret`; `spork-proxy` uses `SPORK_PROXY_SECRET`. Don't conflate them.
- CI/CD: GitHub Actions workflows in `.github/workflows/` — rpc-pipeline.yml, ops-monitor.yml, pipeline-sentinel.yml, allday-ingest.yml, badge-sync.yml, pinnacle-owner-discovery.yml, topshot-active-listings-ingest.yml, topshot-listing-cache.yml, smoke-tests.yml, plus the backstops (sales-indexers, wallet-backfill, snapshot-institutional-wallets, offer-fill, topshot-sales-history-backfill, allow-list-reconcile) and ci.yml. NOTE: there is NO `alert-checker.yml` — pipeline-failure alerting runs via `/api/check-alerts` (`get_pipeline_alerts()` → Telegram+email), triggered by cron-job.org, not a workflow.

### Cloudflare Workers (current full list)

All `.tdillonbond.workers.dev`. Auth surfaces split across rotation domains — see "Worker auth surfaces (3 rotation domains)" above; note `helius-proxy` is a NEW independent surface (`HELIUS_PROXY_SECRET`, never shares `TS_PROXY_SECRET`). 16 worker dirs live under `workers/` (verified 2026-07-19). There is NO `workers/allday-proxy` dir — AllDay GraphQL is served by `topshot-proxy` on its `/allday` + `/allday-consumer` routes.

| Worker (dir) | Purpose | Auth |
|---|---|---|
| `topshot-proxy` | TopShot GraphQL + AllDay GraphQL (public-api + consumer routes) | `X-Proxy-Secret` (`TS_PROXY_SECRET`) |
| `pinnacle-proxy` | Pinnacle GraphQL | `TS_PROXY_SECRET` |
| `pinnacle-events-proxy` | Pinnacle on-chain events (manual/cron-invoked via workers.dev URL) | `TS_PROXY_SECRET` |
| `spork-proxy` | Flow mainnet historical spork access (port 8070) | `SPORK_PROXY_SECRET` |
| `pack-events-ingest` | Pack purchase/open event ingest → `pack_purchases` (TS + AllDay cursors) | `TS_PROXY_SECRET` |
| `topshot-moments-hydrator` | Moment→edition enrichment (`getMintedMoment`) | `TS_PROXY_SECRET` |
| `sports-proxy` (deploys as `rpc-sports-proxy`) | NBA stats / DK projections / cdn.nba.com | `TS_PROXY_SECRET` |
| `odds-proxy` | the-odds-api.com pass-through with apiKey injection | `TS_PROXY_SECRET` |
| `reddit-proxy` | Reddit API access | `TS_PROXY_SECRET` |
| `hybrid-custody-proxy` | HybridCustody event reads against `0xd8a7e05a7ac670c0` | Bearer `INGEST_SECRET_TOKEN` |
| `dune-proxy` | Dune Analytics Query Results API (TopShot ownership-index sync, Pipeline A) | holds Dune API key |
| `helius-proxy` | Solana RPC pass-through (Candy chain-two) | `HELIUS_PROXY_SECRET` |
| `base-proxy` | Base mainnet RPC (`mainnet.base.org`) — Beezie/EVM data plane | `X-Proxy-Secret` |
| `flowevm-proxy` | Flow EVM RPC (`mainnet.evm.nodes.onflow.org`) | `X-Proxy-Secret` |
| `rpc-mcp-proxy` | MCP API-key cache-flush proxy (dashboard `/api/mcp/keys`) | internal |
| `sales-counterparty-backfill` | Recovers counterparties on historical `sales` via Flow REST tx decode — TopShot buyer+seller; AllDay/UFC **seller-only** (their `Deposit.to` is a Dapper custodian, never write it as buyer); Golazos excluded (no transfer to decode). SELF-SCHEDULED (Cloudflare Cron Trigger `*/5` — immune to the cron-job.org dropout class); fill-only + audited via `sales_counterparty_recovered` | `scheduled()` Cloudflare-internal (no auth); manual `fetch()` Bearer `INGEST_SECRET_TOKEN`; NOT on the `TS_PROXY_SECRET` surface (Flow public REST is Workers-reachable directly) |

---

## Supabase schema facts (critical — verify before writing queries)

**Volatile facts (table existence, FMV home per collection, enum values, RLS-on count) are generated from the live DB into [docs/reference/schema-truth.md](docs/reference/schema-truth.md) — that file wins on any disagreement with the prose below.** It is regenerated by the weekly `rpc-data-quality-sweep` (drift → ledger Queued). The conventions below (the two collection vocabularies, partitioning, UUIDs) are stable; the per-table/enum/count specifics can drift, so confirm against schema-truth.md (or re-query) before relying on them.

### Two collection-string conventions (CRITICAL footgun)

The DB uses **two distinct vocabularies** for identifying collections, and they are not interchangeable. Mixing them up will fail INSERTs against CHECK constraints.

| Vocabulary | Used by | Values |
|---|---|---|
| **Long-form** | `sales`, `editions`, `collections.slug` | `nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike` |
| **Short-form** | `flowty_transactions`, `flowty_loans`, `flowty_loan_events` | `topshot`, `allday`, `golazos`, `pinnacle`, `ufc`, `unknown` (the CHECK whitelists exactly these six — NOT `other`, verified live 2026-07-16) |

`flowty_transactions` has a CHECK constraint whitelisting short-form only (live def: `collection IS NULL OR collection = ANY('topshot','allday','golazos','ufc','pinnacle','unknown')`). Writing `'ufc_strike'` to a flowty_* table fails at INSERT — any code writing these tables MUST use short-form (`'ufc'` not `'ufc_strike'`). NOTE: `lib/flowty-tx-classifier.ts` was **removed** in the Flowty-teardown Phase 2 (`36aabf28`, 2026-05-23); the short-form rule still binds any new writer.

The bridge between the two is `analytics_sales` view, which translates long → short via CASE.

### Collection UUIDs

- TopShot: `95f28a17-224a-4025-96ad-adf8a4c63bfd`
- AllDay: `dee28451-5d62-409e-a1ad-a83f763ac070`
- Golazos: `06248cc4-b85f-47cd-af67-1855d14acd75`
- UFC: `9b4824a8-736d-4a96-b450-8dcc0c46b023`
- Pinnacle: `7dd9dd11-e8b6-45c4-ac99-71331f959714`
- Candy MLB (`candy_mlb`, unpublished/`is_active=false`): `209ade70-32c5-4470-bc7c-4793d660f713`

### editions table (32 columns — verified live against information_schema.columns 2026-07-16)

Columns: id (uuid), external_id (varchar), collection_id (uuid), player_id (uuid), set_id (uuid), name (varchar), tier (enum), series (smallint), edition_kind (enum), circulation_count (int), badges (text[]), reward_indicators (text[]), thumbnail_url (text), video_url (text), play_type (varchar), play_category (varchar), game_date (date), home_team (varchar), away_team (varchar), first_minted_at (timestamptz), last_updated_at (timestamptz), created_at (timestamptz), updated_at (timestamptz), set_id_onchain (int), play_id_onchain (int), collection (text), player_name (text), set_name (text), team_name (text), **jersey_number (smallint)**, **subedition_id (smallint)**, **subedition_name (text)**.

The last three were added with the parallel/subedition + jersey-match work: `jersey_number` drives the JERSEY-MATCH special-serial chip (trophy case / special-serial boards); `subedition_id` / `subedition_name` carry the TopShot parallel printing (e.g. Hexwave/Jukebox) on `setID:playID::subID` editions.

The denormalised `player_name` / `set_name` / `tier` / `team_name` / `circulation_count` columns DO exist on this table — safe to select directly.

Pinnacle editions live in parallel table `pinnacle_editions` with different schema: id (text), external_id (text), edition_key (text), character_name, franchise, set_name, variant_type, edition_type, mint_count, is_chaser, thumbnail_url, ask_price, ask_source, plus 10+ Pinnacle-native columns (studio, materials, effects, size, color, thickness). `edition_key` format: `royalty_code || ':' || variant_type || ':' || printing`.

### wallet_moments_cache (wmc)

UNIQUE constraint: `(wallet_address, collection_id, moment_id)` — the cross-collection-safe shape (replaced the old `(wallet_address, moment_id)` on May 6). Columns include `edition_key`, `serial_number`, `tier`, `set_name`, `player_name`, `character_name`, `mint_count`, all populated by JOIN-to-editions backfill RPCs.

### Account linking (May 8)

- `linked_accounts(parent_addr text, child_addr text)` — PK on the pair. 113 links as of 2026-07-16 (was 6 at the May 8 note).
- RPCs: `get_linked_parents(child_addr)`, `get_linked_children(parent_addr)`, `get_linked_all(addr)`, `resolve_canonical_owner(addr)`.
- View: `analytics_sales_resolved` — re-projects `analytics_sales` through canonical-owner resolution to deduplicate parent + child wallets in leaderboards.
- Ingest pipeline: `hybrid_custody_events` cron every 20min via cron-job.org.

### fmv_snapshots table

Wide table — full column set (verified live 2026-07-16): id, edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, confidence, top_shot_ask, flowty_ask, cross_market_ask, sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count, days_since_sale, velocity_factor, utility_factor, loan_factor, algo_version, computed_at, collection, liquidity_rating, asp_without_outliers, ask_proxy_fmv. Key ones: `edition_id`, `fmv_usd`, `confidence`, `computed_at`. **NO `source` column** (still true — do not filter on one).
`confidence` is enum `fmv_confidence` UPPERCASE: `HIGH`, `MEDIUM`, `LOW`, `NO_DATA`, `ASK_ONLY`, `SALES_ONLY`, `STALE`. Never use `.eq("confidence", "high")` — always uppercase, and never use `.ilike` on enum columns (use `.eq` per `f55e022 + e9c90e5` fix).

**Two confidence vocabularies (footgun):** `fmv_snapshots.confidence` accepts `HIGH | MEDIUM | LOW`, but `nba_player_projections.confidence` is gated by a different CHECK that allows only `HIGH | MED | LOW` (3-letter MED).

`fmv_snapshots` is partitioned. `CREATE INDEX CONCURRENTLY` must be standalone `execute_sql`, NOT inside `apply_migration` (which wraps in transaction). FMV write pattern: delete-then-insert NEVER upsert; `collection_id NOT NULL`. Daily duplicates are intentional history, not a bug.

Most recent FMV per edition:
```sql
SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC
```

### sales table

Year-partitioned: `sales_2020` through `sales_2027` (8 partitions, verified live 2026-07-16 — `sales_2027` is pre-created for next year). Dedup on `transaction_hash` (unique index in sales_2026).

### badge_editions table

Has (verified live 2026-07-16): player_name, series_number, tier, parallel_id, parallel_name, play_tags, set_play_tags, low_ask, highest_offer, avg_sale_price, circulation_count, badge_score, collection_id, external_id, set_id, play_id, … There is **NO `badge_type` column** (the earlier note was wrong) — badge tag slugs live in `play_tags` / `set_play_tags`. Use `.or()` with ilike for case-insensitive player name matching. Always `.trim()` player names.

### flowty_transactions table

- `flowty_transactions.failure_category` is unconstrained TEXT and now **historical/frozen** — it was populated by `lib/flowty-tx-classifier.ts`, which was removed in the Flowty-teardown Phase 2 (`36aabf28`, 2026-05-23). The old `FailureCategory` union + first-match-wins `RULES` ordering (specific before broad, e.g. INSUFFICIENT_GAS_FUNDS before INSUFFICIENT_BALANCE) survives only in git history + `docs/flowty-classifier-coverage-findings.md`. (`flowty_loan_events` has been cold since 2026-05-11; this whole subsystem is dead history — distinct from the LIVE Flowty *listing-cache* ingest, see Known issues #1.)
- Flow Error Code 1118 is a payer-gas error (pre-execution), distinct from in-execution Cadence errors. Categorized as `INSUFFICIENT_GAS_FUNDS`.

### General rules

- `apply_migration` for DDL; `execute_sql` for reads/verification.
- Always query `information_schema.columns` before writing route handlers to confirm exact column names.
- RLS check: `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false`. Currently 0 rows — RLS on every public table (290 public tables as of 2026-07-16 live; the invariant is "0 rows", not the count — see [schema-truth.md](docs/reference/schema-truth.md)).
- `health_check()` RPC function is the single source of truth for platform state.
- `pipeline_runs` uses `pipeline` text column (not `function_name`) and `ok` boolean (not `status` text); `extra` is JSONB — use `extra->>'key'` for text extraction.
- Supabase MCP multi-statement queries return only last result — use single statements per call.
- PostgREST caps reads at 1000 rows and CLAMPS explicit `.limit()` above that — paginate with `.range()` or use an RPC for larger reads. A **bare unbounded `.select()`** clamps at 1000 too (sneakier than `.limit(N>1000)`), and dedup-latest-per-edition **in JS over raw `fmv_snapshots` DESC** is a trap — the 1000-row window only covers a few hundred editions (~4,200 TS snaps/day), so use the `fmv_current` view (DISTINCT ON latest-per-edition) instead. **The count-vs-length trap:** requesting `{ count: "exact", head: false }` then reading `rows.length` for a total silently caps that "total" at 1000 — read the returned `count` (with `head: true`) instead. (Both fixed live 2026-07-19/20: lock-roi/market/sets-db truncations + market-pulse `snapshotsToday` 4× undercount.)
- **A batch `.insert()` is ALL-OR-NOTHING — never swallow `23505` on one.** A single duplicate row fails the whole statement and writes NONE of the batch, so `if (err.code === "23505") { /* dupes */ }` silently discards every co-batched **new** row. On a cursored indexer this is *permanent* loss: nothing lands ⇒ the cursor advances past those rows anyway ⇒ they are never retried. Always log only non-dupe errors (`code !== "23505"`) and fall through to a row-by-row retry, so real dupes fail individually while new rows land. **Also note supabase-js RETURNS errors rather than throwing** — a row-by-row fallback placed only in a `catch` block is unreachable for a 23505 (this was `sales-indexer`'s worse variant). Eradicated across all 5 forward sales indexers 2026-07-25 (candy, golazos, allday, ufc ×2 each on `sales`+`unmapped_sales`, plus topshot `sales-indexer`) and pinned by `__tests__/sales-batch-insert-23505-guard.test.ts` (directory-driven over `app/api/*sales-indexer/route.ts`, so new indexers are covered automatically). **NOT the same thing:** the `cron/*-sales-history-backfill` routes' `else if (code === "23505") { ...row-by-row... }` is CORRECT (the positive branch *is* the retry) — don't "fix" those; `pinnacle-sales-indexer` is safe via `.upsert(..., ignoreDuplicates: true)`.
- `players` + `sets`: composite `UNIQUE(external_id, collection_id)`.
- `execute_sql(query text) RETURNS void`, SECDEF, service_role only.
- `tier_type` enum (full live set): `ULTIMATE / LEGENDARY / RARE / UNCOMMON / FANDOM / COMMON / CHAMPION / CHALLENGER / CONTENDER`. Top Shot uses `COMMON / FANDOM / RARE / LEGENDARY / ULTIMATE`; UFC Strike uses `CHALLENGER / CONTENDER / FANDOM`. (`UNCOMMON` / `CHAMPION` exist in the enum too — see [schema-truth.md](docs/reference/schema-truth.md).)
- **Slug-keyed entity lookups need a FUNCTIONAL expression index, or they full-scan the collection.** Any RPC that resolves a URL slug via `regexp_replace(lower(trim(<name>)),'[^a-z0-9]+','-','g') = <slug>` (e.g. `get_team_detail`, `get_player_detail`) cannot use a plain btree — the slug is computed, so the planner scans every row in the collection applying the regexp as a filter. Cold, that page-read amplification (Knicks: 18,121 rows / 8,186 heap fetches / 6,703 buffers) balloons to seconds and HOLDS the pooled connection, surfacing as **"Timed out acquiring connection from connection pool"** on the entity page (Sentry NEXTJS-1Y team + NEXTJS-20 player). Fix is an expression index on the exact immutable expression: `players` has `idx_players_collection_name_slug`; `editions` has `idx_editions_collection_team_slug` (team_name, partial `WHERE team_name IS NOT NULL`, added 2026-07-26 — variant lookup 60→3.5ms, buffers 6,703→501). **A pool-acquire timeout is a SATURATION symptom, not proof of an inherently slow query — profile warm vs cold first** (these RPCs are 23–110ms warm); the lever is cutting the cold-scan that holds the connection, not rewriting the whole fn.

### Security posture (May 3 audit)

0 security ERRORs. SECDEF anon-revoke complete — 10 previously anon-callable fns now `postgres + service_role` only (incl. `query_sql`, `save_user_wallet`, `upsert_wallet_moments`, `pinnacle_upsert_nft_map`, `activate_pro_from_payment`, `classify_acquisition`). RLS on every public table (0 with `rowsecurity=false`). 17 SECDEF views dropped.

**`REVOKE … FROM PUBLIC` does NOT strip Supabase's default per-role `anon`/`authenticated` grant — and this applies to TABLES and VIEWS, not just SECDEF functions** (learned the hard way 2026-07-19: the entire "gated" Panini+Candy dataset — 17 objects incl. `panini_card_serials` with 1,011 collector usernames — was anon-readable via PostgREST because `proxy.ts` gates only the HTTP routes while the tables carried the default `anon` grant). Always `REVOKE SELECT … FROM anon` (and `authenticated` if pre-launch) **explicitly**, and verify with `has_table_privilege('anon', '<obj>'::regclass, 'SELECT')` or a functional `SET LOCAL ROLE anon` probe — **never** by reading `information_schema.role_table_grants`, which still listed `anon` after a successful revoke. **Route-gating ≠ data-gating:** anything staged behind a `proxy.ts` line is still queryable at `/rest/v1/<table>` unless the anon/authenticated grant is explicitly revoked. **MV-derived surfaces need the predicate IN THE VIEW, not RLS** — `refresh_sets_summary()` runs under pg_cron as a `rolbypassrls` role, so an RLS policy on the base table can't filter what lands in `sets_summary`; gate the view arm on `collections.is_active` instead. **FUNCTIONS are the MIRROR case (learned 2026-07-26 clearing the `secdef-anon-exec-drift` sentinel on two new `serial_fmv_estimate` overloads): a new function's default EXECUTE grant is to `PUBLIC` (`=X/postgres` in `proacl`), so `REVOKE EXECUTE … FROM anon, authenticated` removes the explicit rows but `has_function_privilege('anon', …)` STAYS true via the surviving PUBLIC grant — you must `REVOKE EXECUTE … FROM PUBLIC`.** `postgres` (owner) + `service_role` carry explicit grants and survive a PUBLIC revoke, so internal SECDEF callers and `supabaseAdmin` RPC keep working; verify with `has_function_privilege('anon'/'service_role', '<sig>', 'EXECUTE')`, not the ACL text. For a SECDEF fn only reached by service_role clients (`supabaseAdmin`) or by other SECDEF fns (which run as their definer), **revoke** rather than allowlist in `secdef_anon_exec_allowlist` — the drift check (`check_secdef_anon_exec_drift()`) only flags fns that ARE anon/auth-executable, so removing the grant clears it and shrinks the anon surface.

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
- DapperStorageRent: `0xa08e88e23f332538` (reference only — no longer imported by any script since the storefront-cleanup machinery was removed, Known issues #9; the other 10 addresses above are all actively referenced in code, verified 2026-07-16)

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
Routes: `/api/support-chat` (29 tools as of 2026-07-20 — incl. `get_fmv`, `check_wallet`, `analyze_wallet_holdings`, `search_live_deals`, `search_catalog_deals`, `search_across_collections`, `compare_pack_value`, `search_serial_deals`, `get_hot_floors`, `get_edition_sweep`, `get_set_completion_cost`, `get_challenges`, `get_collection_snapshot`, `explain_fmv`, `check_wallet_squeeze`, `manage_deal_subscriptions`, `manage_alerts`, `manage_watchlist`, `get_special_serial_owners`, `escalate_to_human`, `log_bug`/`log_feature_request`/`log_feedback`; plus the 2026-07-20 read-only market/ecosystem reads `get_top_sales`, `get_market_movers`, `get_rookies`, `get_premiums`, `get_ecosystem_stat`, and the generic `get_insight_board` (reads the remaining shareable boards by enum — squeeze/set_squeeze, set_completers, trophies, pinnacle_scarcity, allday_scarcity, topshot/allday pack_market, pack_reality/allday_pack_reality, market) — each wired to an anon-public `/api/public/insights/*` board via the shared `fetchPublicInsight` helper; the 2026-07-20 ship also added the never-disclose security block to the system prompt), `/api/support-chat/feedback`, `/api/support-chat/context`, `/api/support-report`.
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

### proxy.ts site lockdown (May 8 hardened; SOFT-LAUNCH UN-GATE 2026-07-17)

**GO-LIVE / soft launch shipped 2026-07-17 (`65b55209` U1+U3, build-forced by `db04342f`): the read-only feature tabs are now PUBLIC to anonymous visitors.** The un-gate walls **PERSONALIZATION, not CONTENT**: GET/HEAD on `/{slug}/{collection|market|sniper|sets|packs|pack-sniper|challenges|hot-floors|play|analytics}` for the **5 published Flow collection slugs only** (Panini/Candy stay gated — no multi-chain pre-launch), plus a `PUBLIC_READ_APIS` allowlist backing those tabs (market, sniper-feed, packs, sets, recent-sales, wallet-summary, wallet-cache GET-only, …), the `/api/analytics` subtree, and the POST-body stateless read-computes (`/api/fmv`, `/api/best-offers`, `/api/edition-floor`, `/api/pack-ev`). Cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, wallet-cache WRITES, and every mutation API stay behind sign-in (the fail-closed allow-by-explicit-list model keeps gating anything not enumerated). Anon gets a sign-in CTA pill (`AnonSignInPill`).

Order:
1. Bearer `INGEST_SECRET_TOKEN` / `CRON_SECRET` (or `?token=` query) — FIRST.
2. Public path bypass — `isPublicPath(pathname, method)` in `proxy.ts` is the source of truth (it has drifted well past the May-8 list; re-read it before assuming). Besides the feature-tab un-gate above, as of 2026-07-16 the bypass set includes `/`, `/login`, `/early-access`, `/auth`, `/pricing`, `/about`, `/blog`, `/privacy`, `/terms`, `/legal`, `/insights`, `/share`, `/moment`, `/nba/fast-break`, `/admin`, `/favicon.ico`/`/robots.txt`/`/sitemap.xml` + `/sitemap/N.xml`, and the read-only API surfaces `/api/{auth,early-access,admin,cron,public,health,wallet-search,support-chat,og,entity,moment,teams,badge-image,collection-snapshot,collection-stats,marketplace-status,insider-signals,subscribe,track-click,track-funnel}`, plus static. **`/api/cart` is NO LONGER public** (Cart shelved).
3. Else → `getUser` → 60s `rpc_al_check` cookie → `check_email_allowed` RPC.
4. False → `signOut()` + `/login?error=access_revoked`.
5. RPC fail → fail-closed `/login?error=allowlist_unavailable`.

**`/` (root) IS public** (reversed 2026-05-30 as a deliberate funnel decision) — it serves the `HomePageMarketing` landing to anonymous visitors; signed-in users redirect to `/dashboard` inside the page component. Sign-in at `/login`. Banner links `@tdillonbond`.

**FRONT DOOR OPEN — self-serve magic-link signup as of 2026-07-20 (Trevor-directed).** The `check_email_allowed` gate (step 3 above) was flipped from invite-only (`EXISTS allow_list row WHERE status='active'`) to **allow-by-default**: any email gets a magic link EXCEPT one that is explicitly revoked (`allow_list.revoked_at` set, or a blocking `status` in `revoked/rejected/banned/suspended/denied/blocked`) or matched by an active `deny_list` entry (exact `email` or whole-domain `email_domain`). `deny_list` is the ban hammer (takes effect ≤60s via the `rpc_al_check` cookie TTL; no deploy needed). Browsing/search were already public — this opens *account creation*. Migration `audit_20260720_open_front_door_check_email_allowed` (+ `_v2_denylist_types`). The ACL is unchanged (service_role only; anon/authenticated cannot EXECUTE). To ban: `INSERT INTO deny_list (pattern, pattern_type, reason, active, added_by) VALUES (…)`; to revoke an existing account: `UPDATE allow_list SET status='revoked', revoked_at=now() WHERE email='…'`.

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
- **An empty commit — or any docs/`*.md`-only commit — can NEVER force a rebuild on this project.** `vercel.json`'s `ignoreCommand` runs `git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' …`, which exits 0 (→ build skipped) when the diff is empty or docs-only. The reflex "push an empty commit to bake the new env var" silently no-ops (bit an operator activation on 2026-07-19: `DUNE_SALES_INGEST_QUERY_ID` was set, the empty "rebuild" commit `0e243e5e` was skipped in 2.5s, and the pipeline stayed inert while looking activated). The reliable force-rebuild is the v13 deployments POST above, or touch one non-docs file.
- `list_deployments` (with `since` timestamp in ms) → get deployment ID → poll `get_deployment` until READY (~30-38s).
- Free tier: 100 deploys/day limit; rate limiting resolves after ~24h. (RPC is on Pro now.)
- **Pro Lambda `maxDuration` hard cap is 800s.** Anything higher silently sends the deploy to ERROR state — including docs-only deploys — and the build log shows "Compiled successfully" + Sentry sourcemap upload with no logged error text before transition. Commit 32de87a set `wallet-backfill-multicollection` to 900 thinking it was the ceiling; the next 5 deploys all failed invisibly until `b32102e` reverted to 800. Same flavor of invisible failure as the fmv-recalc silent stall — both class of bug looks healthy from every external signal.

---

## Testing & CI coverage (added 2026-07-12)

The repo has a real automated test suite. Run it before shipping non-trivial code changes.

- **Runner:** [vitest](vitest.config.ts) (`npm test` = `vitest run`; `npm run test:watch`; `npm run test:coverage`). Setup file `vitest.setup.ts`; `@` alias resolves to repo root.
- **Two measured layers (coverage `include`: `lib/**/*.ts` + `app/api/**/route.ts`):**
  - **Route handlers** — every `app/api/**/route.ts` is imported and its auth/param guards are exercised; a large subset also drive the 2xx success/accept path by stubbing the `after()` / Supabase seam. Since 2026-07-16/17, flagship route BODIES are also driven end-to-end via the integration harness (below) — sniper-feed 48%, pack-ev 69%, support-chat 22.6% — but the deepest inline surfaces (Flow REST/Cadence scans, SSE streams) still can't be cleanly driven, so a modest line % on the remaining routes is expected.
  - **Pure `lib/**` logic** — unit tests for decode/FMV/pack-EV/market-adapter/logger modules.
- **Route-integration harness + deep-loop fixtures (use these for new route tests):** `__tests__/helpers/route-harness.ts` (`installFetchMock`/`jsonRoute`/`gqlRoute` operationName-matched GQL fixtures/`makeSupabaseFixture` sequence-aware chainable stubs — unmatched fetch throws; the all-empty fixture returns `[]` for every unmocked RPC, often enough to drive a whole GET to a stable 200) and `__tests__/helpers/anthropic-fixture.ts` (`buildAnthropicClass` — replays a scripted sequence of model turns for tool-use loops like support-chat). Usage docs: `docs/audits/test-coverage-integration-harness-2026-07-16.md` + `docs/audits/test-coverage-deep-loop-fixture-layer-2026-07-17.md`.
- **React components** have a separate jsdom harness (`__tests__/*.test.tsx`, ~44 component files; ~565 test files total under `__tests__/`). They are measured **separately** — deliberately NOT folded into the route/lib coverage number (400+ presentational files would swamp the signal).
- **Deno edge functions are excluded** (no Deno toolchain in CI). Their pure logic is extracted into vitest-importable modules under `supabase/functions/_shared` (`cdc.ts`, `hybrid-custody-parse.ts`, `pack-ev-edition.ts` — incl. `computeDualPrice`, `spork-cursor.ts`) and tested there, with lib↔_shared parity + source-drift guards where a routine has a repo copy. When editing an edge fn, put testable logic in `_shared` and import it.
- **WRITING A NEW `*-deep.test.ts`? Type the mock-state `data` field `as any[] | null` from the start.** The single most repeated CI breakage on this repo: a `vi.hoisted` mock state initialised `data: [] as any[]` (TS infers `any[]`) and then an error-path test assigns `{ data: null, error: {...} }` → `TS2322: Type 'null' is not assignable to type 'any[]'`, reddening the **blocking** `typecheck` job for every concurrent session. It happened **four separate times on 2026-07-25 alone** (`72835ebe`, `d872110`, `c2f53227`, and again hours later), each needing a follow-up repair commit. `tsc --noEmit` is NOT run by vitest, so a green local `npm test` does not catch it — run `npx tsc --noEmit` before pushing a new test file. Same for the sibling `TS2741`: give every mock-result object BOTH `data` and `error`.
- **CI ratchet (do not defeat).** `vitest.config.ts` `thresholds` sit just below the live baseline (2026-07-26: **87.3 stmts / 72.3 branch / 90.3 funcs / 89.85 lines**; live actual 87.80/72.82/90.83/90.36, suite ~866 files / ~6,637 tests — raised across the 07-25/26 cont.36–47 passes from 76.3/61.45/82.0/78.9 at the start of that program, itself up from ~45/37/53/47 at the deep-loop program's start; the full comment history in `vitest.config.ts` records every wave's numbers and what it covered), so a coverage **drop** fails CI while normal noise passes. **Raise these as coverage climbs; NEVER lower them to make a red build pass** — but keep a real ~0.1–0.2 buffer under actuals: on this multi-session repo, concurrent pushes add uncovered code and a zero-margin threshold reds CI on otherwise-green work (lesson `47f901a1`). CI job is `unit-tests` in [.github/workflows/ci.yml](.github/workflows/ci.yml), which runs `npm run test:coverage`.
- **DB-invariant SQL tests (added 2026-07-19 — the layer vitest can't reach).** Plain-SQL tests in `supabase/tests/*.sql` pin the behavior of high-stakes Postgres functions/triggers (guards, normalizers, the destructive-op circuit breaker) that live in the database, not in `lib/`/`app/api/`. Each file is **self-contained**: it creates the minimal fixture tables + a **verbatim copy of the committed function DDL** (between `>>> BEGIN verbatim … >>>` / `<<< END verbatim … <<<` markers), asserts the invariant via `_helpers.sql`, and `ROLLBACK`s — so it runs on a vanilla `postgres:16` (only `unaccent` needed) with **no schema apply** (the repo's migrations are incremental `audit_*` patches over an externally-created base and don't rebuild from scratch; some prod objects were applied via MCP and never committed as files). Run locally: `DATABASE_URL=… bash scripts/run-db-tests.sh`. **When you change a pinned function: edit the migration, then copy the new DDL verbatim into the test file** — the blocking `unit-tests` job runs `__tests__/db-invariants-drift-guard.test.ts`, which fails CI if a test's embedded DDL diverges from its source migration. CI job is `db-tests` (blocking as of 2026-07-19), which provisions a throwaway Postgres from the runner's preinstalled `initdb`/`pg_ctl` binaries on port 5433 (a `services:` container hangs on image pull here). **20 invariants pinned as of 2026-07-25** (the drift-guard tracks all 20; `supabase/tests/` also holds `_helpers.sql`). Docs: `supabase/tests/README.md`.
- **Cadence tests** — `npm run test:cadence` extracts inline Cadence (`scripts/extract-cadence.mjs`) and runs `flow cadence lint` against `tests/cadence/fixtures/`. Gated in CI (`cadence-lint` job, needs `flow dependencies install`). See `docs/cadence-testing.md`. Separately, a real `flow test` suite exists for the (undeployed) RPCTradeEscrow contract at `cadence/tests/RPCTradeEscrow_test.cdc` — **16/16 green**, all 12 audit scenarios covered — run locally via `npm run test:cadence:escrow` (fetches deps via `scripts/fetch-cadence-escrow-test-deps.sh` first) and **now run in CI** as of 2026-07-19 (`cadence-escrow-tests` job installs flow-cli from master + fetches pinned ExampleNFT v1.2.2; one-time local setup in `cadence/tests/README.md`).
- **CI jobs (6, all in [.github/workflows/ci.yml](.github/workflows/ci.yml)):** `typecheck` (`tsc --noEmit` over the whole repo incl. `__tests__`), `cadence-lint`, `cadence-escrow-tests`, `unit-tests` (vitest + coverage ratchet + the DDL drift guard), `db-tests` (SQL invariants), and `ledger-guard` (fails a push that DROPS or REMOVES any `docs/overnight/ledger.md` entry — it compares the `^### ` heading **sets** between `HEAD~1`→`HEAD`, not just counts, so a same-count remove-one/add-one swap is caught too, after commit `2966c0a` defeated the count-only check on 2026-07-19; opt out of a legitimate archival roll with `[ledger-roll]` in the commit message).

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

- Flow CLI hot wallet: `0x3aa11c84d776838f` (Key 0, ECDSA_secp256k1, SHA2_256 — BOTH keys re-verified on-chain 2026-07-19 via Flow REST `?expand=keys`). NOT account-linked. `flow.json` gitignored. NEVER use a HybridCustody / linked wallet as the hot wallet. Any code signing as this wallet MUST use secp256k1 + SHA2-256 — `lib/breaks/server-authz.ts` silently used p256 + SHA3-256 until `3b5e62d8` (2026-07-19); tests for signing code must verify signatures cryptographically, never just assert output shape/length.
- Cadence service payer wallet: `0x73f55c4450b8d466` — the account designated as `payer` (gas) for backend-submitted Cadence transactions; distinct from the hot wallet above (Flow allows a separate proposer/authorizer vs. payer). Monitored every 30min by `/api/cron/cadence-payer-balance-check`, which alerts below 0.05 FLOW. If it runs dry, every Cadence transaction fails pre-execution with `INSUFFICIENT_GAS_FUNDS` (Flow error 1118).
- Key env vars: `INGEST_SECRET_TOKEN`, `CRON_SECRET`, `FLOWTY_PROXY_TOKEN`, `TS_PROXY_SECRET`, `RPC_ADMIN_TOKEN`, `SPORTS_PROXY_URL`, `SPORTS_PROXY_SECRET`, `ANTHROPIC_API_KEY`.

---

## Cron / scheduler surfaces (4 independent schedulers)

Scheduled work spans **four** schedulers, not one — verified live 2026-07-06, all green (`detect_stalled_pipelines()` = `[]`, `check_pgcron_recent_failures()` = `[]`):

- **cron-job.org** — ~33 HTTP-triggered pipelines, `*/20` cadence dominant (sales-indexer→AllDay-unmapped-resolver chain, HybridCustody events, ingest). The external console is operator-only; cron entries aren't enumerable from the repo.
- **GitHub Actions** — 16 workflows (`.github/workflows/`), 15 scheduled (rpc-pipeline, ops-monitor, pipeline-sentinel, allday-ingest, badge-sync, pinnacle-owner-discovery, topshot-active-listings-ingest, topshot-listing-cache, smoke-tests, the *-backstop jobs, …; ci.yml is the one non-scheduled). No `alert-checker.yml` exists — health-alert dispatch is cron-job.org → `/api/check-alerts` + `/api/sentinel`.
- **Vercel crons** — 34 entries in [vercel.json](vercel.json) (verified 2026-07-26 — down from 35 after `692da543` retired the inert `drain-base-parallel-probe` schedule, the Population-B base-parallel probe having fully drained; its route + edge fn are KEPT, only the schedule removed, mirroring the `evm-transfers-ingest` disposition; the two newest remaining are the 07-25 AllDay residue drains — `allday-price-recover` at `/api/admin/recover-v1-budget-exhausted` `*/20 * * * *` + `allday-resolve-unmapped-tail` `40 */3 * * *`; before them `candy-listings-indexer` `35 */3 * * *` from the 07-24 Candy parity build; others `allday-lock-refresh-batch` `23 * * * *`, `sync-sales-ingest-dune` `11 */2 * * *`, `candy-offers-indexer` `50 */6 * * *`, and the Dune walkers `sync-sales-seller-recovery-dune` `47 * * * *` + `sync-sales-ingest-dune` — both still **INERT as of 2026-07-19**: `DUNE_SALES_INGEST_QUERY_ID=8030177` is set in Vercel env but the bake never took (empty rebuild commit `0e243e5e` skipped by `ignoreCommand` — needs a real v13-POST rebuild), and the seller-recovery one still needs `DUNE_SALES_SELLER_QUERY_ID=8027085`) (`maxDuration` ≤ 800; pack-grail-MV refresh, rip-metadata backfill, misattribution drain, `/api/cron/warm` business-hours warmer, ownership-sync-dune, …).
- **pg_cron** — ~54 active jobs in `cron.job` (was 53 on 07-16, 34 on 07-06 — the 07-16 IOPS-diet work added several delta-rewrite/catch-up jobs; jobid 201 `rpc-candy-wmc-ghost-purge` added 07-19; jobid 215 `rpc-allday-nem-from-sales-backfill` (`cron_heavy`, `*/30`) added 07-25 as the AllDay free-lane self-heal). In-DB refreshes/backfills: conflated-editions remap, thin-FMV guard, special-serial-owners MV, serial-FMV weekly fits, rookie ownership MVs, rwfd delta/catch-up, …. `check_pgcron_recent_failures()` is the authoritative pg_cron health check (reads `cron.job_run_details`, which `detect_stalled_pipelines()` can't see).

`/api/admin/prune-pipeline-runs` (daily) keeps `pipeline_runs` ~9.5K rows. Notable recurring jobs:

- Sales-indexer chained → AllDay-unmapped-resolver (every 20min, NOT its own cron entry).
- HybridCustody events — every 20min.
- Seed-wallet-refresh — cron-job.org fires every 6h (4 cohorts), but the route's 12h in-route gate (2026-07-18) no-ops half the waves; the GHA backstop passes `&force=1` to bypass it.
- Sync-nba-odds — every 60min during 22:00 UTC → 06:00 UTC.
- ownership-sync-dune (Vercel) — Dune TopShot ownership index; **weekly** re-execution to stay inside the free Dune credit tier.

---

## Deferred hardening

Tracked but intentionally unfixed — revisit when adding a real consumer or a per-row write API.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each have an INSERT policy with `qual=true`/`with_check=true` for `roles=public`. Hardening to add when revisited: per-row size caps via CHECK constraints, `created_at`-based rate-limit column or trigger, `bot_score` column populated from BotID, possibly an unauthenticated rate-limiter at the edge.
- `user_achievements` + `watchlist_items` migrated 2026-04-27 to service-role-only writes. Both still use `owner_key` (text) instead of user_id UUID. Neither table is referenced by any /api route today. When a real consumer arrives, do the user_id+RLS migration like saved_wallets / trophy_moments / profile_bio.
- `badge_editions.low_ask` coverage gap — **AllDay RESOLVED (verified 2026-07-17), the cron this note asked for is LIVE.** `allday-badge-low-ask-refresh` (pipeline_runs, `nfl_all_day`, every 30 min, ok=true, ~3,800 rows/refresh) now keeps AllDay at **3,897/5,607 (69.5%), fresh same-day** — the old "0/1572 always NULL" is stale; do NOT build a second AllDay cron. TopShot healthy and fresh (1,929 low_ask + 1,929 offers; the pct fell to ~28% only because the badge-set backfill grew the row count 2,987→6,930, not a regression). **Still open: Golazos** — **111/218 (50.9%), `max(updated_at)` 2026-07-21 04:26Z (measured by the 07-21 night pass — the older "frozen since 2026-07-08" claim is STALE and was corrected)**. There is still no `golazos-badge-low-ask-refresh` pipeline and `highest_offer` is still 0/218, and what touches these rows is UNIDENTIFIED — so do not close this item on the freshness alone: `with_low_ask` and `max(updated_at)` were unchanged across the 0606Z→0807Z window on 07-21, i.e. it is not a live refresh loop. Extending the AllDay refresh route to Golazos is the fix, but it's a new low-priority scheduled surface on a thin collection — operator/ingest call, not autonomous.

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

3. **Trade Hub — SHELVED (2026-06-01), same class as Cart #1.** On-chain trade escrow (`RPCTradeEscrow`) is not deployed; the 5 submitters in [lib/trade-escrow/fcl-submit.ts](lib/trade-escrow/fcl-submit.ts) were returning fake `0xstub_` tx ids, implying swaps that never happened. Guarded 2026-06-01: each submitter calls `ensureLive()` (throws unless `RPC_TRADE_ESCROW_ADDRESS` is set); the live routes `/api/trade-chain/{propose,execute,deposit-callback,cancel-callback}` + `/api/admin/reclaim-expired-trades` return 503 "Trade Hub is not available yet."; `/dashboard/trade-hub` `notFound()`s via a server gate (split into `TradeHubClient.tsx`). The wishlist/offers/matches CRUD (`/api/trade-hub/*`) is untouched. To re-enable: deploy the contract, set `RPC_TRADE_ESCROW_ADDRESS`, and replace each stub body with the real `fcl.send` per the file's NEXT_STEPS + `RPCTradeEscrow_DEPLOYMENT.md`. Revert the guard: `git revert`. **Update 2026-07-17:** the contract now has a green `flow test` suite (`cadence/tests/RPCTradeEscrow_test.cdc`, 16/16, all 12 audit scenarios + 4 bonus properties), and two latent compile blockers were fixed in the still-undeployed contract (`Trade.execute()` → `settle()` — `execute` is a hard keyword in Cadence ≥1.0 — and the NonFungibleToken import switched to string form). Shelve status unchanged. **Update 2026-07-25 (Claude Code):** completed the panel's Cancel TODO — new `/api/trade-chain/cancel-callback` route (mirrors `deposit-callback`: 503 while shelved, else party-check + status→`cancelled` + `cancel_tx_id`) + client stub `lib/trade-escrow/sign-cancel.ts` (mirror of `sign-deposit.ts`) + `TradeChainPanel.onCancel` now calls it (was console-log-only). Shelve status STILL unchanged — route 503s and the page `notFound()`s in prod.

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

**The canonical forward plan is [docs/strategy/roadmap-2026-07-18.md](docs/strategy/roadmap-2026-07-18.md) (post-launch).** Go-live is DONE and verified (public un-gate 2026-07-17). Phase 1 = prove the product with real users (**the only gate that matters is traction: 50+ WAU**); Phase 2 = cost/latency levers (seed-wallet 12h gate shipped; non-wave wallet-backfill driver queued); Phase 3 = durable debt (hydration view fixed; profile consolidation, mobile polish, monolith refactors remain); Phase 4 = chain two, readiness-gated. Standing guardrails: no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; verify pages by **rendered DOM, not HTTP 200** (streaming shells always return 200).

**Framing (2026-05-24, still binding):** RPC is committed **intelligence-first** — the goal is a product genuinely more useful than nbatopshot.com itself. Cart / live-buy is shelved (see Open #1). **Monetization — the Pro paywall, Stripe — is tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met.

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

- **Top Shot** — `A.0b2a3299cc857e29.PackNFT.Withdraw` where `from = 0x0b2a3299cc857e29` (contract account). Pre-minted reserve pattern. Buyer = matching `PackNFT.Deposit.to` in same tx. `pack_dist_id` is not in the event payload and resolves later (via `pack_rips` on open + a resolution sweep) — platform-wide coverage is normally ~85% of TS `primary_withdraw` rows (measured 2026-07-18; the old "always NULL" phrasing was wrong), but big drops lag (the 07-16/17 14.5k-pack drop crashed daily coverage to ~21–45% → TS-PACK-DIST-NAME-BACKLOG in the ledger).
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
- `get_wallet_pack_history(p_wallet, p_collection_slug, p_status, p_limit, p_offset)` — paginated per-pack timeline with `event_kind` per row and statuses `ripped` / `flipped` / `sold` / `held` / `other`, plus virtual status `sold_any` = `flipped OR sold` (added 2026-07-18 — the classifier marks a bought-then-sold sealed pack `flipped`, so a Sold tab wired to `sold` alone would drop the common case). Uses window functions to avoid N-fold lateral joins (v3 fix). Drives the Packs sub-tabs (Unopened→`held`, Opened→`ripped`, Sold→`sold_any`) on the wallet `?section=packs` view; Moments Owned·Sold uses `?moments=sold` + `/api/wallet/transaction-history?kind=sells`.
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
