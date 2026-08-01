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

**Solana / Candy Digital (in prep):** its OWN readiness trigger is still ≥30 days of Candy Solana sales history (earliest 2026-07-08) + a defined edition/serial schema RPC can index (chain-abstraction Phases A-F already complete). This gate is Candy-specific and does NOT gate other segments. **Drop 1 (2026 MLB Base Series ICONs, $10/pack, 500 packs) landed Jul 17 2026 — Item-0 discovery is COMPLETE and ingested: 125 `candy_mlb` editions / 25,375 serials, daily refresh cron live; `candy_mlb` stays `is_active=false` until the surface is quality-bar clean** (per roadmap-2026-07-18 Phase 4). The Helius proxy secrets are LIVE (operator gate closed 07-16; DAS verified end-to-end); Trevor's Candy Solana wallet is `63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY`. Do NOT treat `candy_mlb` rows / candy `pipeline_runs` as anomalies. **2026-07-19 readiness push:** the data layer reached shared-schema parity minus FMV — tier/set/player/series filled on all 125 editions (`candy-*`-namespaced `sets`/`players` rows), wmc denormalized, 371 ghost-owner rows purged with a daily self-heal (pg_cron `rpc-candy-wmc-ghost-purge`, jobid 201; the DAS group-walk never deletes the prior owner's row on transfer), wmc = 25,375 = supply exactly. The **Magic Eden sales indexer is LIVE** (`candy-sales-indexer`, `CANDY_MLB_ME_SYMBOL` = `2026_mlb_base_series_icons_candy_digital`, Vercel cron `20 */3 * * *`) — first tick 07-19 03:20Z **ok=true, 0 sales** exactly as designed (`SALE_TYPES` excludes `bid` so the bid-only book yields nothing; the first printed sale is captured automatically), and it **proved Vercel egress reaches Magic Eden** (the cloud sandbox is proxy-blocked; prod is not). **Best-offer capture SHIPPED 2026-07-19** (`audit_20260719_candy_offers_scaffold`): table `candy_offers` (PK `pda_address` = the ME standing-offer identity) + view `candy_best_offers` (per-edition max offer with `distinct_bidders` + `offer_count` alongside), fed by route `candy-offers-indexer` (`/api/ingest/candy-offers`, Vercel cron `50 */6 * * *`) — sweeps ME `bid` activities → per-bidder standing offers → Candy-mint gate via `wmc` → upsert; deactivates unseen rows ONLY on a complete sweep (a partial sweep never marks standing offers dead). **HONESTY CONSTRAINT (binding): `candy_best_offers` is a BEST-OFFER signal, NEVER FMV — never fold into `fmv_snapshots`.** **Remaining Candy go-live blocker: zero price signal** (0 sales / 0 FMV / 0 asks; only ME *bids* exist). The bid book is thin and its size is measurement-dependent (probes disagreed 1 vs 2+ wallets; SOL ≈ $76, so observed 0.003–0.04 SOL bids ≈ $0.23–$3.04) — the `candy_offers` pipeline is the arbiter, not any one probe. Whether a bid-derived best-offer reaches a surface at all is a **product decision** (currently there is nowhere to render it — `candy_mlb` has no route dirs and stays unpublished), so silent accrual is correct. **2026-07-24 productization update — the price signal ARRIVED and the first gated surface shipped (supersedes "zero price signal"):** Candy is now printing **~53 sales/24h** (gated, expected — not an anomaly), FMV is computed by the standard collection-agnostic `fmv-recalc` (algo `1.7.0`, **46/125 editions priced, all LOW-confidence off 1–2 sales**; the 79 zero-sale editions stay honest FMV-`—`). Shipped: the **ask feed Candy never had** — `candy_listings` table (PK `pda_address` = ME listing PDA) + `candy_listing_floor` view, fed by route **`candy-listings-indexer`** (`app/api/candy-listings-indexer/route.ts`, Vercel cron `35 */3 * * *`; a Next.js route, NOT a worker — ME page-size capped at **`limit=100`**, 500→HTTP 400, fixed `58cf0818`) — plus **`candy_secondary_board`**, **`candy_pack_ev_model`** (supply-weighted $10 pack = 10 ICONs + 15% Rainbow; **Actual EV ~$86 vs Typical Pull median ~$26**, Rainbow leg largely unpriced), and the **Items A2–E parity boards** (`candy_scarcity_board` / `candy_holder_board` [246 collectors, treasury excluded] / `candy_special_serials_board` [500 rows] / `candy_parallel_player_boards` [Core ~$5.70 vs Rainbow ~$170 FMV, ~30×] / `candy_deals_board` / `candy_offer_spread_board`). The first **gated public board** is live at **`/insights/candy-mlb`** (server page + client + `/api/public/insights/candy-mlb`, tabs Market·Deals·Spread·Serials·Scarcity·Holders·Players; `noindex`; pack-EV block **leads with Typical Pull, not Actual EV**), walled by a NEW `proxy.ts` line gating `/insights/candy` + `/api/public/insights/candy` (Candy was NOT previously route-gated — only Panini was). **Every new Candy table/view is anon+authenticated SELECT-REVOKED** (verified `has_table_privilege` false), read via `supabaseAdmin`. **HONESTY CONSTRAINTS held:** listings/offers are ASK/BID floors, NEVER folded into `fmv_snapshots`; deals/floor read 0 until the first ask prints (ME `listedCount` was 0 under the quest-hold, ~15 asks now ahead of Drop 3). **Go-live (Trevor's call, separate) — now a ONE-LINE flag flip (2026-07-28):** flip `CANDY_MLB_PUBLIC` to `true` in [lib/launch-flags.ts](lib/launch-flags.ts) — that single compile-time boolean atomically un-gates the `proxy.ts` route wall, adds the sitemap slug + `/insights` hub card, and drops the `noindex` in `app/insights/candy-mlb/layout.tsx` + the smoke-test public-page list, in one reviewable deploy (no "un-gated but still noindex" half-ship). The surface flag is INDEPENDENT of two other switches often confused with it: `collections.is_active` (still `false` for `candy_mlb`; governs anon PostgREST reads + cross-collection rollups) and `published` on the `candy-mlb` entry in `lib/collections.ts` (still `false`; governs nav/switcher/per-collection tab routes). Full ordered procedure: [docs/candy-go-live-flip-2026-07-25.md](docs/candy-go-live-flip-2026-07-25.md). The board reads Candy **directly**, so it needs neither the `is_active` flip nor the queued 28-shared-RPC candy-arm fix. **Benign flag (owner action):** the ~11 new Candy views trip `check_public_security_invariants()` `view_unexpected_definer` because they're `security_invoker=true` (Cowork normalized them to `=on` in `audit_20260724_candy_view_invoker_normalize`; the invariant matches only `=on`); no leak (all anon/authenticated-revoked), clears once allowlisted.

**Panini (in prep, INDEPENDENT — runner LIVE as of 2026-07-18):** the residential logged-in box now runs `scripts/ingest-panini-runner.mjs` on Windows Task Scheduler every 4h (`scripts/panini-schedule.bat` registers it, no admin; walk order shuffled so stalled runs rotate coverage `0736fbc4`; pack market data posts up-front `fcc55f27`), live-refreshing ~1,022 editions into `panini_editions`/`_fmv_snapshots`/`_pack_state`. The public surface `/insights/panini-squeeze` (server page + client board + public JSON `/api/public/insights/panini-squeeze` + OG card) is BUILT and STAGED behind the `PANINI_PUBLIC` flag in [lib/launch-flags.ts](lib/launch-flags.ts) (proxy.ts:132 reads it to gate `/…/panini` across page/api/og; go-live = flip the flag, see roadmap R5 + the flag flip below). Pack-EV methodology docs v0.2–v0.4 live under `docs/` (remaining-pool basis; FOTL guaranteed-exclusive-slot edge vs Hobby ~fair) + a WC Nations sealed-value board. The superseded pull-model scaffolding (feed.ts, old normalize.ts, 3 inert cron/ingest routes) was retired `45038b8a`. See [docs/strategy/panini-roadmap-2026-07-16.md](docs/strategy/panini-roadmap-2026-07-16.md). **2026-07-19 CRITICAL finding — discovery is listing-GATED (supersedes the "~20% and listing-biased" note): THE Panini go-live blocker.** The runner enumerates from GraphQL op `getMarketPlaceList` (marketplace listings), so an edition enters the index only once LISTED; of 1,647 discovered editions only **47%** sit in a trustworthy-coverage bucket, and coverage falls monotonically with scarcity (1-of-1 parallels 7–8% discovered, 100% of those currently listed). Measure via the `panini_coverage_audit` view (+ `panini_coverage_summary` for the one-row headline); the dead-end lanes (crafted GQL → 426, psku derivation, fetch override) are documented in [docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md](docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md) — do not re-derive them. **2026-07-19 update — Item 1 RESOLVED: Panini exposes NO full-checklist route** (the SPA has no catalog endpoint to repoint enumeration at), so the only remaining lane is **branch 2b: accept the listing-gated coverage and DISCLOSE it** on any public surface. That disclosure is now **built into the squeeze surface structurally, not as a checklist item** — `panini-squeeze/page.tsx` fetches `panini_coverage_summary` and renders a "treat this board as a floor, not a census" banner, and the public JSON `/api/public/insights/panini-squeeze` carries `meta.coverage` (`basis: "listing_gated"` + note), both fail-soft. The runner is instrumented to capture `/onepanini` request payloads (`PANINI_OPS_CAPTURE_FILE` + `PANINI_DISCOVERY_HOLD_MIN`/`_ONLY`) for one last operator-driven confirmatory pass, now OPTIONAL. **psku correction: `packcard-<setId>_<parallelSetId>_<cardId>_<playerId>`.** Five additional built Panini boards stay deliberately unsurfaced. Go-live is now a ONE-LINE flag flip (2026-07-28): set `PANINI_PUBLIC` to `true` in [lib/launch-flags.ts](lib/launch-flags.ts) — wired into all 5 consumers (proxy.ts route wall, sitemap slug, `/insights` hub card, `panini-squeeze/layout.tsx` robots, smoke-test public list) and pinned both directions by `__tests__/panini-launch-flag-contract.test.ts`; before 07-28 the constant had ZERO consumers so proxy.ts gated `/…/panini` with a bare regex and a flip would have silently no-op'd. Trevor's ordering: Candy ships first, so `PANINI_PUBLIC` stays `false` until Candy is live and healthy. The listing-gated coverage disclosure is a launch REQUIREMENT that travels with the surface — do not remove it.

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
>
> **DATES ARE PACIFIC (Trevor operates in PT). The sandbox/CI clock is UTC — ~7h ahead in summer (PDT), 8h in winter (PST) — so `date -u` on the 29th at 02:54 UTC is still the 28th (19:54) in PT. ALWAYS convert to PT before stamping a `### <date>` here or in `docs/overnight/ledger.md`.** ⚠ **On Trevor's Windows box, run plain `date` (or PowerShell `Get-Date`) — NOT `TZ=America/Los_Angeles date`.** That Git Bash has no `/usr/share/zoneinfo`, so `TZ=<anything> date` silently returns **UTC labelled `GMT`** for every zone (verified 2026-07-31: `America/Los_Angeles`, `America/New_York`, `Asia/Tokyo` and `UTC` all print the same time). It fails silently — you get a plausible timestamp that is 7h ahead — which is exactly how the 07-29→07-30 boundary slip below happened. Plain `date` returns the box's real local time and correctly prints `PDT`. In a UTC sandbox (Cowork/CI) neither works: subtract 7h (PDT) / 8h (PST) from `date -u` by hand. The overnight-pass entries already show the `HH:MMZ / HH:MM PDT` convention; interactive entries must follow the same PT calendar day.

### July 31, 2026 (Claude Code, interactive — panini sale-feed disclosure + continued test-coverage batches, evening) — SHIPPED one honesty-disclosure surface + coverage/lib-extraction batches; primary ratchet → 87.85/73.35/90.7/90.35, component gate held. All direct to `main`, each its own `docs/overnight/ledger.md` entry (2026-07-31/08-01) + revert path.

- **SHIPPED — the public Panini squeeze JSON now DISCLOSES that `serials_with_recorded_price` is a fossil count, not live price coverage (`bf1a665f`).** Upstream stopped supplying serial sale prices on 2026-07-29; the preservation trigger holds the count at 3,925 so it can't drain to zero, but it also can't grow while the feed is out, so its ratio silently declines as the denominator grows (~17% → 7.98%, 3,925/49,208) and a consumer would read it as current coverage. Added `panini_sale_feed_status` (migration `audit_20260801_panini_sale_feed_status`) — a **one-row self-measuring view** (nothing hardcoded, so the disclosure can never go stale, same stance as `panini_coverage_summary`) — surfaced as `meta.sale_price_feed` in `/api/public/insights/panini-squeeze`, **fail-soft in the identical shape to the existing `meta.coverage` block** (a status error omits the block, never 500s the board). Deliberately NOT added to the page: `serials_with_recorded_price` is fetched into the client Row type but is not one of the 10 rendered columns, and FMV+Ask are unaffected (FMV derives from a separate `getCardMarketStats` upstream call, confirmed still moving 18–48% across 07-29→07-31), so no user-visible number is stale and a second banner would dilute the real listing-gated coverage warning beside it. Also fixed a latent table-unaware fixture mock (5→9 tests).
- **Test-coverage continuation (test/lib/CI only, no prod/DB behavior change).** Covered FeatureTabGate / AnalyticsSidebar / FreshnessStamp / AutoSearchReader / ThumbnailPreview components and consolidated dashboard formatters + extracted special-serial-owners helpers into `lib/` (batches 9–11); primary ratchet bumped to 87.85/73.35/90.7/90.35, component gate held ~71 st.
- **Doc correction (`6d535255`, `3ffc2c80`):** retracted an earlier wrong diagnosis — AllDay pull attribution is **structurally capped** (not hydrator-gated); the TS-hydrator priority question was settled by measurement (`7206eb73`), not a hydrator change. No code shipped for either.

### July 31, 2026 (Claude Code, interactive — "implement a TODO" → "Both" → "keep going, on main") — SHIPPED 3 things direct to `main`, each its own `docs/overnight/ledger.md` entry + revert path: (1) deleted the dead `lib/fmv-engine.ts` + test, (2) **wired the RPCTradeEscrow trade-escrow submission layer** (still INERT/shelved), (3) a component-coverage batch (gate 70.3→71.01 st).

Task began as "find a straightforward TODO and implement one." A full sweep (greps + a dedicated exhaustive Explore pass) re-confirmed the standing finding — **no safe, LIVE, implementable product TODO exists**: every actionable marker is SHELVED (trade-escrow, blocked on the undeployed `RPCTradeEscrow`), GATED (candy/panini/odds go-live flags), or already RESOLVED. Durable outcomes:

- **Deleted dead `lib/fmv-engine.ts` + its test** — zero non-test importers, superseded by the DB FMV pipeline; removed a misleading `// basic for now` TODO with no runtime effect.
- **Trade-escrow submission layer WIRED (Trevor-directed after reviewing the tradeoffs).** The 5 `fcl-submit.ts` submitters + the 2 client sign helpers now do real `fcl.mutate`; new `lib/trade-escrow/cadence.ts` holds the templates. **Still fully shelved/INERT in prod** (ensureLive gate + routes 503 + page notFound). ⚠ **UNVERIFIED + UNTESTED ON-CHAIN — must testnet-dry-run before go-live**; go-live now needs BOTH `RPC_TRADE_ESCROW_ADDRESS` (server) and `NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS` (client). Full detail in the updated Trade Hub note (Open #3) + the ledger. **The Cadence MCP was NOT available this session** (verified via ToolSearch) — the mandated mainnet verification could not run, hence the UNVERIFIED status.
- **Component-coverage batch** — covered 3 untested logic-bearing components (`FeatureTabGate` route-access gate, `AutoSearchReader` URL-param/saved-wallet search, `ThumbnailPreview` hover/blank-image guard); component gate 70.3/58.0/67.3/74.0 → 71.01/58.60/67.99/74.77, thresholds bumped ~0.2 under.
- **Method note (this session):** the git env is EXTREMELY concurrent-heavy right now — survived ~5 push rejections / ledger rebase-conflicts, resolving each by keeping ALL entries (splice, never whole-file rewrite). `npm ci` fails in-sandbox (Node 22 vs CI 24) — use `npm install` then `git checkout package-lock.json`; run vitest via `node_modules/.bin/vitest` (a bare `npx vitest` fetches a fresh copy that can't resolve `vitest/config`). This sandbox HAS a working push credential (unlike the desktop-Cowork note above).

### July 31, 2026 (Claude Code, interactive — "analyze test coverage → do all you can" run) — SHIPPED a durable **component-gate ROT-GUARD** + 6 test/refactor batches lifting the component gate 68.73→70.51 st; primary gate held at 88.28/73.62/91.08/90.8. All test/CI-only or pure-refactor, direct to `main`, each its own `docs/overnight/ledger.md` entry (2026-07-31, batches 1–6) + revert path.

Started as a coverage analysis. The two measured gates were already near-saturated, so the entire value was in the layers they structurally CAN'T see. Durable outcomes:

- **THE FLAGSHIP — the component gate was an ALLOWLIST with a silent-rot hole, now closed by an enforced invariant.** `vitest.components.config.ts` measures a curated `include` list of subtrees, so a NEW `components/<feature>/` dir contributed ZERO to the ratchet until a human remembered to add it — untested financial UI could land with nothing reddening CI. New `__tests__/component-gate-include-completeness.test.ts` enumerates every `components/*/` subdir holding logic-bearing `.tsx` and **fails the blocking `unit-tests` job** unless each is in the gate's `include` OR an explicit `KNOWN_UNMEASURED` allowlist (cart/filters/legal/play/pricing/ui/visual, each with a reason). **DURABLE: when you add a `components/<subtree>/` dir, you must either gate it (add to the `include` + write tests) or add it to `KNOWN_UNMEASURED` with a reason — the guard reds CI otherwise. When you gate a subtree, delete its `KNOWN_UNMEASURED` entry (a two-way check catches stale/ghost entries too).** The guard immediately surfaced 3 real gaps, all closed this session: **auth** (ConnectButton/ProBadge/SignOutButton, 91.5% st), **marketplace-status** (banner/dormancy-chip/unavailable-pill), **onboarding** (FirstRunTour step-machine + dismiss/localStorage) — all now in the `include`.
- **Extracted pure logic out of the un-measured `app/**` page layer into `lib/` (now on the PRIMARY ratchet), byte-identical bodies, established "extracted to @/lib/… imported below" pattern.** `lib/rewards-tier.ts` (tier-progression math off `rewards/page.tsx`), 4 new `lib/market-format.ts` exports (`fmtUsd`/`TIER_COLORS`/`tierColor`/`ownLockLabel` off `market/page.tsx`), 3 new `lib/pack-dist-format.ts` exports (`fmtPct`/`fmtCount`/`tsTileImg` off the 2,758-line pack-dist monolith), and the analytics marketplace helpers (`shortSlug`/`marketplaceLabel`/`marketplaceColor` + maps off `analytics/page.tsx`) → `lib/analytics/format.ts`. **The `app/**` page layer (218 non-API `.tsx`, ~66.6k lines incl. the dashboard/moment/pack-dist/sniper/analytics monoliths) is measured by NEITHER gate — the safe, proven lever is peeling PURE helpers into `lib/` + unit-testing; the stateful monolith splits still need rendered-DOM validation and are not a blind-sandbox job.**
- **Covered 8 previously-untested logic-bearing components** across the batches: PaywallModal, CollectionSwitcher, ThemeToggle, RefCapture, AnonSignInPill, ExplainButton, FunnelTracker, TelemetryPageView, and **MomentHeroMedia** (the image-candidate fallback state machine — the guard against the documented "~30% blank black hero on legacy Series 1-4 editions" regression).
- **DELIBERATELY NOT attempted (the two remaining structural gaps — both need tools absent in this sandbox; a future session with them should take these):** (1) **promote `edge-deno` to blocking** — 16 `deno check` errors remain; needs Deno + a deploy-verify session per [docs/handoff-2026-07-30-deno-edge-ci.md](docs/handoff-2026-07-30-deno-edge-ci.md); promoting blind would red `main`; (2) **wire `npm run db:pins:check` into a scheduled workflow** — it needs `SUPABASE_SERVICE_ROLE_KEY` so it can't live in the DB-less `unit-tests` job, but it's the ONLY thing that catches a pin validating a definition prod has stopped running (3 were found stale on 07-31). Both are unverifiable from here; I left them rather than ship something I couldn't prove. Also stopped extracting monolith helpers once the remaining candidates were trivial one-liners (forcing those is coverage theater).

### July 31, 2026 (Claude Code, interactive — sales tx-index handoff items 21–22 + a long test-coverage "keep going" batch) — made `public.sales` able to store a multi-item transaction at last (386 AllDay sales promoted), fixed the drainer's cross-source-dedup mislabel, and lifted the component-coverage gate ~62.9→68.7 st while hardening the flaky Cadence/edge CI. Every item its own `docs/overnight/ledger.md` entry (2026-07-31) + revert path; direct to `main`.

Landed after the OFF-HOURS overnight pass below. Every claim re-verified live first; two handoff documents were found materially wrong and corrected in the ledger.

- **DB — `public.sales` can finally represent a bulk buy (`audit_20260731_sales_tx_unique_admits_multi_item_transactions`, DB-only, no deploy).** `idx_sales_tx_hash` was `UNIQUE (transaction_hash, sold_at)`, so every item of one purchase shared both keys → the table held **one row per transaction**, silently dropping every item but the first. Replaced with `UNIQUE (transaction_hash, nft_id, sold_at) NULLS NOT DISTINCT WHERE transaction_hash IS NOT NULL` (per-partition `CREATE INDEX CONCURRENTLY`→`ATTACH`, no blocking rebuild); `NULLS NOT DISTINCT` (PG 17.6) preserves the old strictness for the 15,951 legacy `nft_id IS NULL` rows. ⚠ **The handoff's plan would have no-op'd** — it named only the parent index; `sales_2026` also carried a standalone, parent-less `(transaction_hash)`-alone unique index (stricter than the parent), dropped in the same migration. **Durable: when widening a partitioned unique index, enumerate per-partition indexes too.** Drained 389 stale `sales_tx_hash_unique_collision` markers → `promote_unmapped_sales(allday)` promoted **386/389**; `sales` now holds 21 multi-item transactions / 48 rows, structurally impossible before. The handoff's ~$30k payoff was ~29× overstated (the bulk fail the edition-resolution gate, not the index; 25,154 zero-price rows can never promote — hard `price_usd>0` guard — so no FMV-poisoning risk either way).
- **DB — the drainer stops mislabelling trigger-suppressed rows as tx-hash collisions (`audit_20260731_promote_unmapped_sales_classify_cross_source_dedup`, DB-only, no deploy).** `promote_unmapped_sales()`'s ladder fell to `tx_hash_collision` for any row the AllDay cross-source-dedup trigger (`trg_zzz_allday_cross_source_dedup`, BEFORE INSERT, `RETURN NULL`) folds into an economic twin — no error, 0 rows inserted, twin under a different tx_hash → recycled forever. Added a fourth outcome `merged_cross_source` (predicate mirrors the trigger's guard + economic key), treated as RESOLVED (the sale IS recorded, on the twin); ELSE arm renamed `insert_vanished`. Corrects the item-21 "3 genuine dupes" claim — those 3 were cross-source merges, now cleared. Also **re-pinned the stale DB invariant** — the drift guard still pointed `promote_unmapped_sales` at its 2026-04-27 migration (superseded 07-27), so its SQL test validated a dead definition; rewrote against the live shape (trigger installed verbatim), drift guard **42/42 green**. ⚠ Both SQL tests' first real run was CI's blocking `db-tests` job (this Windows box has no Postgres/Docker — the "sandbox can run the harness" note is the *cloud* sandbox); it caught a fixture bug — **a NULL `resolution_hint` makes a row uncandidatable** (`NOT (NULL AND NULL)` is NULL → fails the WHERE); fixtures must use `'{}'::jsonb` (0 live rows have a NULL hint, so inert in prod).
- **Test-coverage "keep going" batch (test/CI/config only, no prod/DB state).** Lifted the component-coverage gate **62.9 → 68.7 st** across the day: covered SupportChat's streaming path (the biggest single uncovered in-gate component, 45.6→68.2% — the `ReadableStream` reader loop + `\x1e` record-separator meta split), CollectionMomentTable's mobile expanded panel, the PacksDashboard/BadgeRow/TeamFollowButton/CostBasisCard/WalletHydrator render layers, and populated-row tests for the smoke-only public insights boards (each row-mapping now exercised, not just the empty branch); thresholds bumped ~0.3 under actual each batch. Also brought the `app/insights` board clients under the component gate (new `app/insights/**/*Client.tsx` include in `vitest.components.config.ts` — every published insights board is now measured; a future untested board reds CI). **CI hardening:** the flaky `raw.githubusercontent.com` Flow-CLI install reddened `main` twice — strengthened both `cadence-lint` + `cadence-escrow-tests` installs to 6 attempts / ~2min budget + `curl --retry`; and the new non-blocking `edge-deno` job's `deno check` caught **3 genuine edge bugs**, fixed (plus a `sloppy-imports` + cache prestep to resolve the import map).
- **The flagship of those 3 edge bugs was a LIVE PROD BUG: `scan-pinnacle-wallet` had been writing NOTHING to `wallet_moments_cache` since June 10** — the 2026-06-10 fix `acf85c04` ("repair the broken 2-col onConflict writers") accidentally deleted the `.from("wallet_moments_cache")` line, so `supabase.upsert(...)` threw at runtime every run. Restored (repo only; **needs a `supabase functions deploy scan-pinnacle-wallet`** to reach the live fn — no cron caller, manually/opportunistically invoked). Durable: a "fix" commit can regress worse than the bug; `deno check` (even non-blocking) earns its keep.
- **`edge-deno` fully root-caused (see the CI-jobs entry below for the standing reference).** Errors 21→16 (`--unstable-sloppy-imports` fixed the `_shared/cdc` class). The residual 16 are a `--node-modules-dir=auto` × jsr-subpath/URL toolchain conflict, NOT edge-source bugs; the `jsr:`→`npm:` remap was CI-tested and did NOT clear them. The bounded real fix (delete the 12 type-only `edge-runtime.d.ts` imports → drop `--node-modules-dir=auto`) needs a Deno **+ deploy** session — this sandbox has no Deno, so CI was the only adjudicator. Playbook in [docs/handoff-2026-07-30-deno-edge-ci.md](docs/handoff-2026-07-30-deno-edge-ci.md).

### July 31, 2026 (overnight pass — OFF-HOURS monitor-mode) — fired 08:45 PDT (late/afternoon); shipped 0 (correct); post-ship watch of the 07-29→07-31 wave ALL PASS; health GREEN; 0 new inbox

Fired 15:45Z / 08:45 PDT — outside 00:00–06:00 local, so MONITOR-MODE (queue, don't ship). No clock skew (shell ≈ DB now() ≈ max sale ≈ max fmv). Prior lock RELEASED, push available, no FREEZE, `origin/main` `787fee10` unchanged start→end (a Claude Code session pushed through ~15:07Z, then stopped). Handoff: [docs/handoff-2026-07-31-overnight-pass.md](docs/handoff-2026-07-31-overnight-pass.md).

- **Ship 0 correct.** Off-hours; and no new low-risk shippable candidate existed — every finding is healthy-by-design, home-box-external, or already-queued off-limits/gated.
- **Post-ship watch ALL PASS, 0 reverts.** FMV 1000-row-cap fix (`71b04635`): `fmv_current` 26,773=distinct editions, `security_invoker=true`, anon SELECT false; TS FMV HIGH+MED 2,958. Conflated-drain (`cd775ec1`): nightly `wmc_split`=**8,125** (was 0/1/2), remaining 795 draining. `unmapped_resolution_backlog_max` 24h-grace (`35aa7c3b`): **85** ok (breach 100). profile/teams IDOR (`dbabf575`) + analytics force-dynamic (`009f08e7`): READY, 0 new Sentry. 07-31 CI/edge/component/docs: test/CI/config only.
- **Health GREEN.** security 0/0/0/0; pg_cron []; trust 23 metrics 0 breaches; Sentry 0 unresolved/48h; Vercel prod READY (0 ERROR/last 20); DB 11,721 MB (+377). pipeline_alerts 3 all info (panini home-box asleep pre-launch; ufc_sales bridge; nfl_all_day backlog net-draining). 36 fails/24h all normal (wallet-backfill whale/per-wallet ~1.3% vs 455+ OK; topshot-active-listings 7 egress_blocked but latest OK).
- **Queued (no new-and-actionable):** GHA-ACTIVE-LISTINGS-INGEST-DROPOUT (night 3) carried forward with a symptom shift (now firing-then-egress_blocked-then-recovering vs silent-dropout; visibility-only). Plus 07-29 deep-dive residuals, the WMC-realign loop, edge-deno→blocking, and a scan-pinnacle-wallet redeploy.

### July 29, 2026 (Claude Code, interactive — "implement a TODO → find bugs → do all → do all of them → deep-dive sweep", one long thread) — shipped ~13 fixes across route/component/DB/edge layers + deployed 4 edge fns; flagship win = killing the FMV 1000-row-cap class. Every item its own `docs/overnight/ledger.md` entry (2026-07-29/30) + revert path; direct to `main`.

Began as "implement a straightforward TODO" (none safe — all gated/shelved, only a stale candy-discovery comment fixed) and grew into a full bug sweep + 4 parallel deep-dive agents (FMV / analytics / auth-wallet / deal-intel). Durable outcomes:

- **FLAGSHIP — the FMV 1000-row-cap class is fixed platform-wide.** Raw `fmv_snapshots` reads ordered `computed_at DESC` + JS latest-per-edition dedup overflow PostgREST's 1000-row cap (~35 daily-history rows/edition), so cold editions are dropped → null FMV → deals vanish from the sniper board, pack EV understates, `/api/fmv` falsely says "No FMV data yet" (proven 45/50). Fix: **widened the `fmv_current` view** (migration `audit_20260730_widen_fmv_current_add_enrichment_cols`, append-only + `security_invoker=true` re-asserted) to carry `asp_without_outliers, sales_count_30d, days_since_sale, liquidity_rating` alongside the existing 11 cols, then swapped **8 readers** to it (sniper-feed, pack-ev, allday-pack-ev, `/api/fmv` POST batch, wallet-search ×2, allday-wallet-search, cache-refresh, golazos-sniper-feed) + chunked their `.in()` at 1000. **DURABLE RULE (reinforced): NEVER read raw `fmv_snapshots` DESC + JS-dedup for latest-per-edition — use `fmv_current` (DISTINCT-ON latest, 1 row/edition, now carries the enrichment cols; `asp_usd` is exposed as `wap_usd`).** `__tests__/invariants-postgrest-cap.test.ts` `RAW_FMV_DESC_ALLOWLIST` is the two-way guard (flags NEW raw readers + STALE allowlist entries) — it was pruned of the 8 migrated files; `/api/fmv` GET (`.limit(1)`, one edition) + sniper-feed (`"fmv_snapshots"` confidenceSource literals) legitimately stay on it.
- **SECURITY — `app/api/profile/teams` POST was a live IDOR** (no session check; resolved a body `ownerKey`=public username → service-role replace-all of that user's teams). Now `requireUser()` + write target = session id (ownerKey must resolve to caller else 403). GET (public) unchanged.
- **CRASHES — two React/render fixes:** `CollectionMomentTable` expanded badge panel called `.toFixed()`/`.toLocaleString()` on nullable `badge_editions` cols (16 rendered editions incl. Wembanyama) → white-screen; guarded + made `BadgeInfo.{burn_rate_pct,lock_rate_pct,circulation_count}` honestly `number|null` (tsc then surfaced 2 more unguarded reads). `SetsDashboard.SeriesOverview` had a `useMemo` after an early return (Rules-of-Hooks) → crashed when filtered to an empty-series collection; hook moved above the return.
- **EDGE — the "cursor advances past a failed fetch/write → silent permanent data loss" class fixed in 4 fns AND DEPLOYED via MCP** (`ingest-pinnacle-mints` v4, `pinnacle-owner-discovery-forward` v22, `pinnacle-owner-discovery` v26, `hybrid-custody-events` v12; all `verify_jwt=false` preserved). The 3 Pinnacle event fetchers now **throw** on non-OK Flow REST (was `return []`, indistinguishable from an empty window → cursor advanced past it); hybrid-custody holds the cursor on a `record_link_state` WRITE failure (idempotent, safe retry). Validated ok:true via post-deploy cron ticks (pinnacle-owner-discovery v26's ~90-min tick self-confirms ~02:30Z; shares the identical throw fix as the proven-ok v22 forward walker).
- **DURABLE — MCP edge-fn deploy mechanics (learned this thread):** `deploy_edge_function` inlines the whole body, so regeneration risk is real for byte-exact constants (`?key=` GATE, cursor IDs, Flow URLs) — deploy a MINIMAL DIFF (prior body + only the fix). The repo uses BARE imports (`@supabase/supabase-js`) resolved via `supabase/functions/deno.json`, but deployed fns historically carry inline `esm.sh` URLs — a naive repo-file deploy of the bare form breaks unless you ALSO pass `deno.json` + `import_map_path` (needed for `hybrid-custody-events`, which also imports `@supabase/functions-js/edge-runtime.d.ts`). Deploy bundling is **fail-safe** (a bad import/syntax → deploy errors, old version stays). Verify via the next **cron `pipeline_runs` tick** (ok:true), NOT a manual curl — the auto-mode classifier blocks outbound gated calls, and Bearer-gated fns can't be triggered without the secret.
- **Smaller ships:** `execute_sql`→`query_sql` in `edition-stats` + `market-feed` (were calling the void-returning fn → dead reads); `overview-stats` HIGH-confidence KPI counted `fmv_snapshots` history rows (~14× inflated) → now `fmv_current`; `cursor_stall_threshold()` `search_path` pinned (cleared the lone advisor WARN); `topshot-active-listings-ingest` GHA sweep got a `DEADLINE_MS` wall-clock budget + `curl --max-time` (was SIGKILLed at the 30-min job timeout → silent total loss when Atlas slowed; Atlas self-recovered ~23:34Z 07-29); 2 analytics routes got `force-dynamic`; `/api/analytics` confidenceDist seeded `SALES_ONLY`.
- **QUEUED (not rushed — precise fixes in the ledger 2026-07-29 "QUEUED" entry):** sniper-feed "Badges only"/"Special serials" filters silently no-op on the live RPC path (HIGH, needs enrichment rework — a wrong post-filter empties the board); `/api/analytics` whale totals capped at 10k moments (needs a server aggregate RPC); `edition-floor` Flowty-leg-not-edition-scoped + persist-path corruption (masked/opt-in); `best-offers` empty-editionKeys early-return; `pack-roi` (dead, null ROI); `wallet/save`+`export-csv` latent-IDOR-if-revived (schema-drift-broken, no callers); FmvDashboard `SALES_ONLY`/`STALE` badge mislabel (needs `FmvConfidence` type widening). None page or corrupt data today.

### July 29, 2026 (Claude Code, interactive — "analyze test coverage → proceed with all → Both → do it all" long thread) — closed the two structural coverage blind spots the ~88% headline can't see (the proxy auth wall + a monolith), then did the FULL edge-fn Deno-CI refactor Trevor chose. Every item its own `docs/overnight/ledger.md` entry (dated 2026-07-30 — UTC-boundary slip; all PT 07-29) + revert path; direct to `main`.

Started as "analyze test coverage & propose improvements." The measured layer (`lib/**` + `app/api/**/route.ts`) is saturated (~87.8/72.8/90.8/90.4), so the value was entirely in the layers **both** coverage gates EXCLUDE. Three fronts (P1/P3 test-only + safe; P2 a real refactor):

- **P1 — the `proxy.ts` auth wall was at 0% coverage (highest-risk gap).** `isPublicPath(pathname, method)` (~395 lines) is the whole public/gated security boundary, lives at repo root so NEITHER gate measures it, and is the function behind every "gated surface was anon-reachable / launch flag silently no-op'd" ledger incident. Added a one-token `export` (Next.js only consumes `proxy`+`config`, zero behavior change) + `__tests__/proxy-is-public-path.test.ts` — a **117-case `(path,method)→public|gated` table** incl. the staged Panini/Candy gates overriding the general `/insights|/api/public|/api/og` bypasses, and a behavioral flag-flip test (`vi.doMock`+`resetModules`) proving `PANINI_PUBLIC`/`CANDY_MLB_PUBLIC=true` actually un-gates. **Durable: when changing `isPublicPath`, update that table — it's the security contract.**
- **P3 — extracted 8 PURE helpers from the ~2,000-line `app/moment/[id]/page.tsx` monolith** → new `lib/moment-detail-format.ts` (`fmtUsd`/`fmtRelDate`/`fmtAbsDate`/`tierColorVar`/`collectionLabel`/`urlSlugForCollection`/`slugifyTeam`/`decodeMomentId`) + 21-case test. Import-back, byte-identical bodies, tsc-clean. This is the SAFE monolith pattern (pure helper→lib); the stateful `WalletMomentsBody`/feed split still needs rendered-DOM validation and was NOT attempted.
- **P2 — the edge-function Deno CI gate + full import-map refactor (Trevor picked the full path over revert/leave-non-blocking).** NEW `edge-deno` job in `ci.yml` (`deno check` + informational `deno lint`), **NON-BLOCKING** (`continue-on-error`). **DURABLE — the edge fns were type-checked by NOTHING** (vitest/tsc cover only lib+routes; no Deno toolchain elsewhere). To satisfy newer Deno's `no-import-prefix`/`no-unversioned-import`, added **`supabase/functions/deno.json` (an import map)** and **rewrote 36 fns' inline `https://esm.sh`/`jsr:` imports to bare specifiers** (`@supabase/supabase-js` etc.; import-lines ONLY, no logic; supabase-js standardized to jsr `@2`). ⚠ **NEW edge code MUST use bare specifiers (via the import map), not inline URLs.** `deno check` then found **24 real type errors** in the previously-unchecked edge source (the gate's payoff) — I fixed the **2 version-independent genuine bugs** (`snapshot-institutional-wallets` undefined `ids` TS2304 crash-in-error-path; `sales-serial-backfill` `.catch()` on a supabase-js builder that's a thenable, never worked, TS2551×2). **21 errors remain** (implicit-any/Timeout in `compute-topshot-pack-ev`, spread-overwrite, a likely version-strictness `.upsert`).
- **DURABLE — edge-fn CI state + footguns (READ before touching edge fns or the gate):** (1) `edge-deno` stays **NON-BLOCKING** until the remaining 21 `deno check` errors are fixed, then drop `continue-on-error`. (2) **`deno check` CANNOT be verified from this sandbox** — jsr.io/esm.sh are proxy-blocked (403); CI is the first place it runs (install deno from the GitHub release, not deno.land — that's blocked too). (3) **The repo source now DIVERGES from the DEPLOYED edge fns** — nothing was redeployed; the next `supabase functions deploy <fn>` ships the bare-specifier version resolved via `deno.json`. Verify by deploying ONE low-risk fn first; `compute-topshot-pack-ev` (flagged do-not-redeploy/byte-identical) had its import line changed too. Full remaining-21 list + fix/version-pin/deploy-verify procedure + Cowork block: [docs/handoff-2026-07-30-deno-edge-ci.md](docs/handoff-2026-07-30-deno-edge-ci.md).
- **Method notes:** the git env is concurrent-heavy — survived ~8 push rejections by re-reading + splicing the ledger each time (never whole-file rewrite; the ledger-guard checks heading SETS). `npm ci` fails in-sandbox (Node 22/npm 10 vs CI Node 24) — use `npm install` then `git checkout package-lock.json`. All CI green throughout (edge-deno non-blocking).

### July 29, 2026 (overnight pass — OFF-HOURS monitor-mode) — fired 16:28 PDT (afternoon); shipped 0 (correct); post-ship watch of the 07-28/29 test/docs wave ALL PASS; health GREEN; 1 new queued (GHA active-listings dropout)

Fired 23:28Z / 16:28 PDT — outside 00:00–06:00 local, so MONITOR-MODE (queue, don't ship). No clock skew (shell ≈ DB now() ≈ max sale ≈ max fmv). Prior lock RELEASED, push available, `origin/main` `b36cc2c1` unchanged start→end. Handoff: [docs/handoff-2026-07-29-overnight-pass.md](docs/handoff-2026-07-29-overnight-pass.md).

- **Health GREEN.** security 0/0/0/0; trust 23 metrics 0 breaches; pg_cron `[]`; Sentry 0 unresolved/48h; Vercel prod `b36cc2c1` READY, 0 ERROR/last 20; DB 11,514 MB (+170). `unmapped_resolution_backlog_max` 87 (up from 63, still <100). `sentinel_ts_uuid_editions_48h` 6 (was 0; tiny, normal growth).
- **Post-ship watch — 07-28/29 wave ALL PASS, 0 reverts.** Last ~24–48h of `main` is entirely test/docs (CC test-coverage + DB-pin + PT-date-correction); the three `20260729000*` migrations are documentation-snapshots NOT applied to prod. 07-28 `golazos_offers` cursor_stalled suppression holding; `edition_integrity_flags` 102 (sane).
- **QUEUED (1 new): GHA-ACTIVE-LISTINGS-INGEST-DROPOUT** — `topshot-active-listings-ingest.yml` (GHA `29 */3`) silent ~22.3h (>900-min cap; exceeds its own 12.6h historical max), ~7 missed ticks since last ok run 01:13Z. GHA scheduler dropout, NOT an execution failure (every run that fires succeeds); sibling `topshot-listing-cache` healthy so live TS listing coverage intact; medium/visibility-only, does not page. Fix = backstop / widen threshold / accept — not a low-risk DB/doc ship.

### July 28, 2026 (Claude Code, interactive — "analyze test coverage → proceed with all → keep going → do those → do all of that", one long thread, ~14 batches) — exhausted the component tree of logic-bearing untested components (gate 44.6→63.2 st), closed 4 zero-test-ref edge fns via `_shared` extraction, and added 5 DB-invariant pins on the FMV read/write + sales-integrity paths (23→28), each VALIDATED on a real postgres:16 stood up locally. All test/config-only, direct to `main`, every batch its own `docs/overnight/ledger.md` entry (2026-07-28) + revert path.

- **The measured primary layer was already SATURATED and stayed untouched.** `lib/**` + `app/api/**/route.ts` sits at ~87.8/72.8/90.8/90.4 with zero untested lib modules; this whole thread was the layers that number EXCLUDES. Do not re-chase the primary aggregate — its remaining tail is inline Flow-REST/Cadence/SSE bodies `vitest.config.ts` documents as expected-modest.
- **Component gate 44.6 → 63.2 st (Batches 2–13, ~30 new `.test.tsx`).** A programmatic re-scan (logic-density ≥5 over every gate subtree) now returns **ZERO** untested components carrying real branch logic — fetch dashboards, CRUD cards, chart math (PortfolioSparkline/HeldTimeDistribution), the auth flow (SignInWithDapper), and the big ones (WalletPacksView, TeamChecklist, TrophySlab, SupportChat, HomePageMarketing). What's left is presentational chrome (spinners/badges/layout leaves, no branches) — testing it is coverage theater. **A future "improve component coverage" ask should NAME a specific feared component, not the aggregate.**
- **4 edge fns that had ZERO test reference are now pinned** via the established extract-to-`_shared` + source-drift-guard pattern (no edge SOURCE touched — Deno fns are outside CI coverage): `seed-*-pack-distributions` (`classifyDist` collection-filing + the `b64ToUtf8` mojibake guard), `pinnacle-nft-resolver` (`extractEditionKey`), `scan-pinnacle-wallet` (full CDC `unwrap`), `backfill-pack-opens-api` (`toRip` pull-count). New `_shared` mirrors sit outside the primary include so the ratchet is unaffected.
- **TWO leaked-timer flakes found + fixed — same class, worth remembering.** A component that schedules a REAL timer which later fires a relative-URL `fetch` (throws in node) leaks past test teardown and reds a *random later file* in the full run (passes in isolation → looks flaky). Hit by AchievementsCard's 2000ms refresh `setTimeout` and WalletPreloader's `AbortSignal.timeout(15000)`. **Fix: no-op the timer in that test** (`vi.spyOn(window,"setTimeout")` / stub `AbortSignal.timeout` to a plain signal). Verified via 4 consecutive full component-suite runs (670 tests, 0 failures). When a component test passes alone but the full run flakes, suspect a leaked timer, not the assertion.
- **DB-invariant pins 23 → 28 — the layer vitest can't reach**, all validated against a real `postgres:16` I stood up locally (initdb/pg_ctl as an unprivileged user, `unaccent` in `extensions`, `scripts/run-db-tests.sh` 28/28). The 5 new: `backfill_nft_edition_map_from_sales` (the derivability gate that binds the LIMIT to recoverable rows — the 07-27 "green-while-blind" defect — + determinism + latest-wins + on-conflict), `promote_unmapped_sales` (edition-resolution precedence + serial COALESCE + 7-day archive; deps stubbed), `backfill_null_serial_sales_from_moments` (moments→wmc serial precedence + `>0` guard + idempotency), **`get_wallet_moments_with_fmv`** (THE wallet-display read — latest-FMV-per-edition/future-ignored, sort ladder, filter+total_count, the `price_band_30d` outlier-trim gate, the `{moments,total_count}` envelope; `serial_fmv_estimate` stubbed), and **`upsert_topshot_marketplace_fmv`** (the marketplace→FMV WRITE honesty gates — no_edition, ULTIMATE-skip, don't-overwrite-HIGH/MEDIUM, sales-precedence, median×3 cap, troll-ask/ceiling clamps, DELETE-ONLY-TODAY). Method reminder: pin against the LATEST migration's DDL verbatim between the `>>> BEGIN/END verbatim <<<` markers, add a `PINS` entry so `db-invariants-drift-guard.test.ts` keeps the copy honest, and stub external fn deps (like `fmv_from_sales`/`log_pipeline_run`/`serial_fmv_estimate`) rather than inlining them.
- **DURABLE — this sandbox CAN run the DB harness.** Postgres 16 binaries (`initdb`/`pg_ctl`/`psql`) + the `unaccent` contrib are present; `useradd`+`sudo -u` works. So a SQL pin can be validated end-to-end here before pushing — do it, don't push a hand-written pin blind.
- **Not chased, on purpose:** `scripts/**` classification logic (tombstoned/manual, live path already tested), the remaining unpinned DB fns (env-dependent security probes like `check_public_security_invariants`, or thin RPC wrappers with no crisp invariant). Pinning those is coverage theater.

### July 28, 2026 (Claude Code, interactive — browser-QA + handoff-drain wave, ledger rounds 1–5 + launch-flag drain) — centralized the STAGED-surface launch flags, disclosed `/insights/deals`' largest (undisclosed) collection, restored `<h1>`s to ~30 heading-less tab routes, and retired a dead Dune cron — all direct to `main`, no PR

A multi-round interactive day draining a stack of browser-QA + audit handoffs. Every item has its own dated `docs/overnight/ledger.md` entry (2026-07-28) + `git revert` path; code+tests+docs only — **no prod-DB mutation beyond one additive-then-DROP view contract change**. Commits `36cd2acd`→`d5f95ec3`.

- **Launch flags CENTRALIZED — new [lib/launch-flags.ts](lib/launch-flags.ts) (`36cd2acd`).** Taking a staged `/insights` surface public was a 5-file touch (proxy wall, sitemap, hub card, layout `robots`, smoke list) — 5 chances to half-ship (un-gate but leave `noindex`). Now `CANDY_MLB_PUBLIC` / `PANINI_PUBLIC` are single compile-time booleans each fanning out to all 5 consumers, so go-live is a one-line atomic diff. `PANINI_PUBLIC` had had ZERO consumers (proxy gated `/…/panini` with a bare regex), so a flip would have silently no-op'd; both directions now pinned by `__tests__/panini-launch-flag-contract.test.ts`. Both flags stay `false` (Candy ships first, Trevor's call). **The go-live mechanism prose in the Candy/Panini strategy sections above and the "Key files" entry reflect this — the old "delete the proxy.ts:127 line" instruction is superseded.**
- **`/insights/deals` was hiding its LARGEST collection (`d5f95ec3`, ledger round 5).** `cross_collection_deals_board` UNIONs THREE legs — Top Shot, **NFL All Day (47% of rows, the single largest)**, Pinnacle — but every surface named only Top Shot + Pinnacle, and `VALID_COLLECTIONS` in the public API omitted `nfl_all_day` so it returned **HTTP 400** for its own biggest slice. Fixed all six copy sites + the allowlist + added the All Day filter chip. Also: the `HIGH`/`MEDIUM` confidence pills (internal enum on an unauthenticated page) were **relabelled** `CONFIDENCE`→**FMV BASIS**, `High/Med`→**Standard/Strict** — control kept (it's the reader's only defence against an FMV-derived gap), vocabulary dropped per the no-confidence-UI policy; query param byte-identical. Corrected a third false claim (a blanket "$5+ floor" that is Top Shot-only; 100/240 rows sit under $5).
- **Panini squeeze headline now LEADS with the honest lower-bias figure (`4e9730ab`/`358ea522`, round 4).** Board headlines the `_hc` lower-bias subset (**$644,215 · 2,144 editions**) with the all-sets blend ($1,636,380 · 3,764) demoted to a labelled sub-line + a per-row bias-risk badge; `coverage_flag` is a listing-bias INDICATOR, never a coverage measurement, and the copy says so. schema-truth.md regenerated **290→340 public tables** (Candy/Panini build-out; 0 structural drift — every table/enum/UUID CLAUDE.md names is byte-identical).
- **SEO `<h1>` restoration (`8e53b936`→`d5f95ec3`, rounds 2–3).** New `components/CollectionHeading.tsx` gives ~30 heading-less collection tab routes a structural h1 (depth ≤ 2 → h1, minus the 9 tabs + all entity routes that already own one). ⚠ **DURABLE, recorded twice:** (a) an anonymous `fetch(redirect:'follow')` on an auth-gated route returns HTTP 200 with the **/login body** (~21.35 KB on this site) — measuring h1s on that is measuring the login page; my round-2 "regression" evidence was this artifact and I REVERTED my own double-h1 on `/analytics/{loans,sales}` in round 3. (b) Deriving "heading-less" from `grep -c '<h1' page.tsx` misses pages whose heading renders from a child component (packs/play/pack-sniper) → double-h1 on first deploy. **Confirm h1 counts from RENDERED HTML (`curl -sL | grep -c '<h1'`), recording `res.url`/`res.redirected`, never from a grep or a redirect-following fetch.** Also: `/api/analytics/health` no longer prerendered at build (missing `dynamic='force-dynamic'` baked a 500 first snapshot; static page count 412→411).
- **`/api/recent-sales` unknown-slug guard (`8e53b936`, round 2).** An unknown collection slug fell through to GLOBAL (Top Shot) sales returned under the bogus slug — now short-circuits to `{sales:[]}` before touching the DB, preserving the omitted-param `/profile` default. An existing test had PINNED the bug (asserted the unscoped query as correct) — rewritten. Same round dropped the misleadingly-named `real_sales` column (`serials_with_recorded_price` — price COVERAGE, not activity) via a DROP+CREATE that had to recreate the dependent `panini_squeeze_totals`, re-assert the anon/authenticated REVOKE, and restate `security_invoker=on` (all three traps `CREATE OR REPLACE VIEW` can't handle).
- **Dead Dune cron retired (`36cd2acd`).** `sync-sales-ingest-dune` (36 runs / 0 ok — its query-id bake never took) dropped from `vercel.json` (34→33 crons); route kept, schedule removed. `package-lock.json` also repaired so `npm ci` installs again (`2b37281c`).

### July 28, 2026 (overnight pass) — GENUINE OVERNIGHT (~01:03 PDT, no skew); shipped 1 (golazos_offers cursor_stalled suppression, DB-only, subagent PASS 4/4); post-ship watch of the 07-28 interactive wave ALL PASS; health GREEN

Fired 08:02Z / 01:02 PDT (in-window, no skew). Push available, no FREEZE, `origin/main` `9301485` unchanged start->end. Shipped **1** DB-only, reverted 0, repaired 0, drained 0 inbox (empty). Handoff: [docs/handoff-2026-07-28-overnight-pass.md](docs/handoff-2026-07-28-overnight-pass.md).

- **SHIPPED — `audit_20260728_suppress_golazos_offers_cursor_stalled_staged_inert` (DB-only).** A NEW false-positive **HIGH `cursor_stalled`** page fired for `golazos_offers`: the 07-28 `golazos-offers-indexer` is **staged-inert** (mirror of live `allday-offers-indexer`, shipped for test parity) with **no scheduler** (not in `vercel.json`/GHA/`cron-schedule.md`); a one-off manual tick at 01:01:34Z seeded its `event_cursor` row and it never re-ran, crossing the 6h `cursor_stalled` threshold ~07:01Z and paging via `/api/check-alerts` with no live meaning (live `topshot_offers`/`allday_offers` cursors fresh). Silenced via one additive INSERT into `pipeline_alert_suppression` (the designed table; precedent `topshot_listings`/`ufc_listings`/`golazos_listings`), bounded **30d** (decision-pending: schedule the indexer or delete the cursor; remove at go-live). Independent subagent **PASS 4/4**. **Revert:** `DELETE FROM public.pipeline_alert_suppression WHERE pipeline='golazos_offers';`
- **Post-ship watch — 07-28 interactive wave ALL PASS, 0 reverts.** `edition_integrity_flags` metric fix now reads 100 (was pinned ~5), ok, breach_at 250 — intended, not a regression. `recent-sales` hydration fix (`07811f27`) READY, 0 new Sentry. All other 07-28 commits test-only (both CI ratchets green).
- **Health GREEN.** security 0/0/0/0; trust 23 metrics 0 breaches; stalled `[]`; pg_cron `[]`; Sentry 0 unresolved/24h; Vercel prod `9301485` READY (0 ERROR/last 20); DB 11,344 MB (+134). FMV TS H+M flat 2860. No new inbox; all other queued items off-limits/gated/hot-file. **QUEUED (1 new):** TS-PARALLEL-SUBEDITION-CIRCULATION-STRAGGLERS (53 canonical parallels missing circ; on-chain subedition supply needed).

### July 28, 2026 (Claude Code, interactive — "analyze test coverage → proceed with all" MEGA-thread, 8 batches) — ~315 test-only tests across every layer the primary coverage number EXCLUDES; component gate 30.2→45.0 st; the whole `lib/**` tree is now 100% test-referenced

An "analyze test coverage → keep going ×8" thread. The measured primary layer (`lib/**` + `app/api/**/route.ts`) was already **mature and is now SATURATED** (88.2/73.5/91.0/90.8, and a full-tree sweep confirms **zero untested lib modules remain**), so the entire value was in the layers that number does NOT measure. 8 batches, each its own ledger entry (2026-07-28) + revert path; **test/config-only + a handful of additive `export`s of pure helpers — no product runtime, migration, edge-fn/worker SOURCE, or prod-DB change.** Every push `tsc`-clean, both CI ratchets green, clean (no concurrent-reject). Commits `ccc935df`→`638e2dff`.

- **THE DURABLE MAP — the 88% headline measures only 2 of ~6 layers; the value is in the other 4.** Primary `include` is `lib/** + app/api/**/route.ts` ONLY. Uncovered by it (and each closed this thread): (1) **Cloudflare workers** `worker.fetch(req, env)` with stubbed `fetch` — covered the 6 dark ones (base/flowevm/helius RPC-passthrough, pinnacle-proxy GQL+render-SSRF, reddit-proxy allowlist+cache, odds-proxy param-whitelist); a dropped auth check = an open paid-egress relay. (2) **Deno edge fns** — extract pure primitives to `_shared` + a source-drift guard that greps the edge source for the inline copy (edge SOURCE untouched → no deploy); added ufc-wallet-enrich (mojibake+tier), topshot-subedition-parse (circulation), atlas-pool-normalize (drop-pool), sales-serial-parse (address+serial gates) — the fabricated-data P0 class. (3) **React components** — their OWN gate (`vitest.components.config.ts`, `.test.tsx` only), climbed **30.2→45.0 st** here. (4) DB invariants (SQL, untouched this thread).
- **Component-gate method that WORKS (per file type):** prop-driven components → render + assert; fetch dashboards → **stub every child to a marker + stub `fetch` per-endpoint URL**, then drive the component's OWN code (multi-endpoint Promise.all / separate useEffects, the loading + **soft-fail `catch`** state machine, window/collection re-fetch, inline empty states). Covered ALL SIX big analytics dashboards (Sales/Fmv/Loans/Listings/Sets/Pulse, 330–740L each) + both pagers (EditionsGridPaginated, SalesTablePaginated-adjacent) + NetMarketplace/Lender leaderboards + TeamHero/EditionActivity + ShareProfileButtons (referral/rewards). Where a component hides pure helpers, **export them** (established here: FmvHistoryChart/VolumeChart/EditionGrid/PacksDashboard/WalletsHubOverview `fmtUsd`/`pivot`/etc.) and unit-test — same pattern as PinnacleFmvChart.
- **GOTCHAS worth keeping (all cost a red run here):** (a) a `.test.ts` importing a component gets NEITHER ratchet — the component gate `include`s only `*.test.tsx`, primary excludes `components/`; **name component tests `.test.tsx`.** (b) An analytics endpoint that returns `{}` (not `[]`) when empty **throws on `.map`** because `?? []` only catches null/undefined (the component's own ListingsDashboard comment) — return `{rows:[]}` fixtures. (c) testing-library `getByText` matches an ELEMENT'S full text, so a two-text-node cell renders `"+$3.4k"`, not `"$3.4k"`. (d) A `type="email" required` input is blocked by jsdom **native constraint validation** before the app's own validate branch runs — that belt-and-suspenders branch is unreachable via the input; assert the observable (no fetch) instead. (e) `makeSupabaseFixture` captures fixtures BY REFERENCE — reassigning `fx.tables={}` detaches it (already a Proxy now, but watch for the class). (f) bump BOTH ratchets ~0.3 under live actual after each batch; never lower to green.
- **Highest-value NON-render wins this thread:** the **golazos-offers-indexer** (staged-inert offers pipeline) driven **0→covered** by porting the live allday-offers-indexer deep suite (the inert-path silent-failure class — a bad edit sits undetected until revived against live money); the **weekly-digest `after()` send-loop** silent-failure legs (send-fail is retry-safe: skip, NO delivery row, pipeline stays ok); and the **break-transactions** Cadence templates — the LAST 0% module in all of `lib/**` (shelved-path structural pin: Cadence 1.0 syntax + mainnet addresses + single-signer/Withdraw-entitlement/length-assert).
- **Where I STOPPED, and why (do not re-chase for the number):** the big dashboards' numeric logic already lives + is tested in `lib/analytics-*-compute`; what remained after this thread is **presentational leaves** (spinners/badges/tier-chips/layout chrome — no branches to pin) and the inline **Flow-REST/Cadence/SSE route bodies** `vitest.config.ts` documents as expected-modest and not-worth-forcing. Testing those is coverage theater, not risk reduction. If a future session is told "improve coverage," point it at a SPECIFIC feared file/feature, not the aggregate.

### July 28, 2026 (Claude Code, interactive — "implement a TODO" → health-check + audit thread) — SHIPPED one DB fix: a structurally-dead trust-health metric that had been blind to editions drift; investigated + honestly declined two others; full re-audit + smoke test GREEN

Started as "find a straightforward TODO and implement it," became a health check + "fix anything off." One DB-only ship; every finding + revert path in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-28, top entry).

- **SHIPPED — `audit_20260728_fix_edition_integrity_flags_metric` (DB-only, no deploy).** The `edition_integrity_flags` arm of `v_rpc_trust_health` read `count(*) FROM v_edition_integrity_flags` — but that view is a per-collection `GROUP BY` (one row per collection ⇒ **always 5**), so the metric was pinned at ~5, could never reach `breach_at=50`, and the real defect columns it computes were **never summed** → genuine editions drift was UNMONITORED. Rewired to `SUM(canonical_bad_circulation + canonical_missing_tier + canonical_missing_thumbnail)` across collections (excludes the accepted ~6.5k TS UUID-dupe residue + the structurally-null candy/ufc on-chain-id columns), `breach_at` 50→**250** (above the continuous thumbnail-hydration baseline; Trevor's call to include thumbnails). Now reads **104** (53 bad-circ + 8 missing-tier + 43 missing-thumbnail), ok. Rebuilt from `pg_get_viewdef` via a **guarded `regexp_replace`** (RAISEs if the arm doesn't match, so a whitespace miss aborts rather than silently no-ops) so the rest of the 23-metric view is byte-identical; `security_invoker=on` re-asserted (CREATE OR REPLACE VIEW wipes reloptions).
- **DURABLE LESSON — a health metric that reads `count(*)` of a `GROUP BY` summary view counts GROUPS, not problems.** It looks alive (returns a plausible small number, status ok) but is structurally incapable of breaching. When adding/reviewing a `v_rpc_trust_health` arm backed by a summary view, confirm it aggregates the *defect columns*, not the row count. The safe way to edit that giant sentinel view without transcription risk: `pg_get_viewdef` → guarded `regexp_replace` (abort on no-match) → `CREATE OR REPLACE VIEW` → re-assert `security_invoker=on`.
- **INVESTIGATED, deliberately NOT fixed — the 53 flagged canonical TS editions are all `setID:playID::subID` PARALLEL editions missing parallel-specific circulation** (single 2026-07-07 batch; **98.5% of parallels ARE filled**, so these are stragglers, and NULL is NOT the parallel norm). NOT clear-cut: **0/53** have a wmc `mint_count`, **0** an observed serial, only **23** a sale serial (a lower bound — Series-8 parallels still minting). Correct value = on-chain subedition supply (ingest domain); guessing (base-edition circ / max-serial) would inject wrong scarcity into FMV/pack-EV — the fabricated-data P0 class. Left for the subedition circulation sweep; the fixed metric now tracks the class. **Unconfirmed hypothesis worth checking if this recurs:** parallel circulation appears to be filled as a side-effect of pack-EV/subedition hydration, so parallels never entering an active drop pool may stay NULL indefinitely.
- **TODO task: none shipped — no safe non-gated live TODO exists (re-confirmed 07-28).** Exhaustive sweep (+ a dedicated Explore agent): every literal TODO is shelved (trade-escrow / undeployed contract), an operator go-live gate (Candy/Panini/Fast-Break/Rewards), already resolved (RTR v2 / solana constants / code-todos #1), or dead code (`lib/fmv-engine.ts` — zero non-test importers, superseded by the DB FMV pipeline). Do not manufacture a risky FMV/ingest/metric change to "have shipped one."
- **Health + re-audit + smoke test ALL GREEN.** security 0/0/0 + secdef-exec-drift `[]`; 23 trust metrics 0 breaches; 0 stalled; 0 pg_cron failures; Sentry 0 unresolved/24h; CI green on HEAD; Vercel prod READY; DB 11 GB. 0.6% pipeline-run failure rate all known/expected (Dune `402` billing cap, cold-spork `500`, the already-retuned AllDay-resolver productivity-floor spike now 0 fails/day). **To run the smoke test:** the `/api/smoke-test` endpoint is token-gated (WebFetch 403), so trigger `smoke-tests.yml` via `workflow_dispatch` (it holds the token + runs `scripts/smoke-gate.py`) and read the run conclusion — run 3286 `success`.
- **Branch:** direct to `main` per CLAUDE.md; no PR.

### July 28, 2026 (Claude Code, interactive — "analyze test coverage → implement all → keep going" thread) — 13 test-only commits closing the STRUCTURAL blind spots the primary coverage number can't see: Deno edge fns, Cloudflare workers, the component gate, route error legs, and a DB-invariant pin

Started as "analyze test coverage and propose improvements," became "all of them" then "keep going." The measured `lib/**`+`app/api/**/route.ts` layer was already mature (~88/73/91/90), so the value was entirely in the **unmeasured layers**. Every item is in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-28, "test-coverage batch" heading + Gap-C+/D+/B+/A+/D++/B++/B+++/C++ bullets) with its own `git revert` path. **Test/config-only throughout — no product runtime, migration, or prod-DB change; no edge-fn or worker SOURCE modified.** All 7 CI jobs green on every push (primary gate final: 7,382 tests / 920 files, coverage 87.73/73.25/90.69/90.28; component gate 30.17/27.29/28.34/31.29). Ran through ~6 concurrent-session push rejections — merged each keeping ALL ledger entries.

- **DURABLE METHOD — the coverage number lies by omission; test the layers it excludes.** The primary vitest `include` is ONLY `lib/**` + `app/api/**/route.ts`. Four whole layers contribute nothing to it and can rot silently: (1) **Deno edge functions** (`supabase/functions/**`, no Deno toolchain in CI), (2) **Cloudflare workers** (`workers/**`), (3) **React components** (own separate gate, `vitest.components.config.ts`), (4) **DB functions** (`supabase/tests/*.sql` SQL-invariant harness). This session hit all four.
- **Edge fns — extract-to-`_shared` + source-drift guard, NEVER modify the edge fn.** The flagship `compute-topshot-pack-ev` is kept OFF the shared rewire (do-not-redeploy, byte-identical to prod), so mirror its pure primitives (`editionExtKey`/`normalizeTier`) into `_shared`, unit-test them, and add a drift guard that reddens CI if the inline copy diverges — the edge source stays untouched so no deploy is implied. Same pattern pinned the **reduced** `unwrapCdc` (Optional/Array/Dictionary + `default→value`, NO Struct/Event flattening) shared by 3 serial-backfill fns → `_shared/cdc-reduced.ts`, asserted DISTINCT from the full `_shared/cdc.ts`. **Money-primitive gap is the 07-25 fabricated-EV P0 class.**
- **Workers are directly testable — `import worker from "…/index.ts"; worker.fetch(request, env)` with a stubbed global `fetch`.** Covered `topshot-proxy` (X-Proxy-Secret + route dispatch), `hybrid-custody-proxy` (Bearer + event allowlist + 250-block cap), `dune-proxy` (Bearer + the **/execute body ALLOWLIST** — only `query_parameters`+`performance` reach Dune), `spork-proxy` (the spork-SELECTION: single-spork routing, cross-boundary/floor 400s, tx-walk), `pinnacle-events-proxy` (50k-block cap, event aggregation). A dropped auth check = an open proxy; a mis-route = silently-wrong data — both were invisible before. **Gotcha:** a `.ts`-path worker import needs `// @ts-expect-error` (TS5097); a `.js` one does NOT (unused-directive error). And a `new Request(url, {headers, ...init})` helper must spread `...init` FIRST then `headers` last, or `...init` clobbers Authorization.
- **Component gate 20.7% → 30.2%** by testing the biggest LOGIC-bearing components (not presentational): `CollectionMomentTable` (850-line table, 0→46%), `WalletProfile` (1,000-line lending card, 0→70%), `TopBuyers`, `PositionTransfersCard`. Prop-driven ones render from a fixture; fetch-on-mount/open ones stub global `fetch` + mock `useResolveUsernames`/`WalletIdenticon`. **Gotcha:** jsdom money assertions must match the component's exact formatter (`$2.50M` not `2.5M`; `12.50%` not `12.5%`); this repo's wallet labels render `whale` not `@whale` in some components. Always bump BOTH gate ratchets ~0.3 under live actual after adding component tests.
- **Route error legs — the silent-failure class.** Drove the previously-dark 500/degrade/normalization branches of `cost-basis`, `recent-sales`, `profile/{achievements,hero-moment,trophy}`, `wallet/pack-history`, `telemetry` by capturing the RPC/insert PAYLOAD (not just the status) so normalization + identity-resolution + first-wins-dedup are actually asserted.
- **DB-invariant pin (23rd) — `mcp_get_fmv`** (concierge FMV read): typed-error guards, serial-multiplier ladder (#1→12x/≤10→4.5x/≤23→2.8x/else 1x), latest-snapshot-wins, gaps flags. Verbatim DDL from the committed migration + a `db-invariants-drift-guard.test.ts` PINS entry. **Validated locally against a real `postgres:16`** — this sandbox HAS `initdb`/`pg_ctl`/`psql`, so run `scripts/run-db-tests.sh` under an unprivileged user (`useradd pgtest`; pg refuses root) with `-k /tmp/pgrun` before pushing a SQL pin. The lone local `norm_player` FAIL is the documented `extensions.unaccent`-schema quirk, not a regression.

### July 28, 2026 (Claude Code + Cowork, interactive — "proceed / do all you can" monolith + Golazos-recon thread) — 5 monolith Phase-2 slices out of `collection/page.tsx`, the Recent Sales panel hydrated, Golazos offers proven to have NO offer book (route stays inert), + a durable Pinnacle-route caveat

Multi-turn thread; every item is in [docs/overnight/ledger.md](docs/overnight/ledger.md) (2026-07-28) with its own `git revert` revert path. All CI-green, `tsc` clean on each push, each deploy verified READY. Ran through ~4 concurrent-session push rejections — merged each time keeping ALL ledger entries (heading-set guard doesn't care about order), re-verified tsc on the merged tree before pushing.

- **Monolith Phase-2 (`collection/page.tsx`) — 5 slices now extracted, page ~2,900 → ~1,386 lines.** Four PURE lifts (Claude Code, verbatim + unit-tested): `lib/collection/{export-csv, server-moment, totals, filter-sort}.ts` (the last is the core filter+sort row-selection ladder). One STATEFUL slice (Cowork): `components/collection/CollectionRecentSales.tsx` (the `recentSales`/`salesLoading` cluster — the most isolated `useState` group; parent keeps one `searchNonce` counter), browser-validated by DOM query on all 4 served collections; it also exposed and removed a dead `sealedPackCount` useState (assigned every search, read by nothing). **Remaining Phase-2 = the stateful `WalletMomentsBody` split proper — medium-risk, needs rendered-DOM validation across collections, so human/Chrome-in-the-loop, not a blind sandbox push.**
- **DURABLE — the `[collection]/collection` route serves only FOUR collections, not five.** Disney Pinnacle has its OWN page (`app/pinnacle/`, never carried this panel/monolith) and its OWN data plane (`pinnacle_editions` / `pinnacle_fmv_history` / `pinnacle_sales`). So for any slice from `collection/page.tsx`, "validate all 5" = 4 (TS/AllDay/Golazos/UFC) + Pinnacle separately, and **route-level fixes against `editions`/`fmv_snapshots`/`sales` do not reach Pinnacle by construction.** Recorded in [docs/audits/refactor-plan-monolith-pages-2026-05.md](docs/audits/refactor-plan-monolith-pages-2026-05.md).
- **Recent Sales panel hydrated (`app/api/recent-sales/route.ts`).** It had returned `playerName`/`setName`/`fmv` as hardcoded `null` (panel rendered ~60% `—`) — a hydration gap, not a data gap (payload already carried `editionKey`). Added `player_name, set_name` to the `editions(...)` embed (denorm cols, all 4 Flow collections) + one batched `fmv_current` `.in("edition_id", ids)` lookup → per-row `fmv` (numeric-coerced); FMV query error is swallowed so a FMV hiccup degrades "vs FMV" to `—` rather than 500-ing the tape. +4 tests proven-to-fail against the null body.
- **DURABLE — Golazos has NO DapperOffersV2 offer book; do NOT re-attempt the offers indexer.** Cowork ran the recon from an env with Flow REST egress: **0 Golazos offers** across a fully-covered contiguous 400k-block window carrying 14,495 `OfferAvailable` events (TopShot 9,460 · MFLPlayer 3,986 · AllDay 775 · MFLClub 274 · **Golazos 0** · UFC 0) + 0 across six samples Feb→Jul; positive control same path AllDay 142/24h, TopShot 1,979/24h. Cause is **demand** (Golazos traded ~6 moments in 4 days). The `golazos_open_offers` table + `app/api/golazos-offers-indexer/route.ts` stay **staged INERT** — they light up free if offers ever print; do not wire a cron until `offersSeen > 0`. **Correction:** `marketplace_offers`' 284 Golazos rows are frozen Flowty-extractor output (`edition_id` NULL on all rows), NOT evidence of DapperOffersV2 offers. So the one genuinely-open Golazos gap (`badge_editions.highest_offer` 0/218) has no source to fill — leave it.
- **`npm ci` failing in the sandbox is the documented Node-22/npm-10 vs CI Node-24/npm-11 artifact, NOT a `main` breakage** (verified: last 6 `ci.yml` runs on `main` all success with `npm ci` in all 4 blocking jobs). Never commit a regenerated lock to "fix" it — that breaks CI.

---

### Older sessions

Archived to `docs/sessions/` (newest-first within each file):

- `docs/sessions/2026-07.md` — July 27 → July 1 (overnight passes + daytime CC; Candy chain-two productization/parity, sales-counterparty/Panini readiness, Pack-EV accuracy program, IOPS read-diet, Trophy-case PDF, test-coverage infra, platform audits).
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
- `lib/launch-flags.ts` — single-source-of-truth compile-time launch flags (`CANDY_MLB_PUBLIC`, `PANINI_PUBLIC`) for STAGED public `/insights` surfaces. Each flag fans out to 5 consumers (proxy.ts route wall, sitemap, `/insights` hub card, the surface layout's `robots`, smoke-test public list) so go-live is a one-line, atomically-cascading, git-reviewable diff. Flipping either is a PUBLIC-EXPOSURE change — Trevor's call only.
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
- RLS check: `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false`. Currently 0 rows — RLS on every public table (340 public tables + 122 views as of 2026-07-28 live; the invariant is "0 rows", not the count — see [schema-truth.md](docs/reference/schema-truth.md)). RLS-on is not the whole posture: also check `check_public_security_invariants()` and `check_anon_write_surface()` (both 0 rows 2026-07-28), since the default anon grant survives `REVOKE … FROM PUBLIC`.
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

**Auditing "who can actually call this?" — three traps, all hit on 2026-07-31 (client-executable SECDEF taken 61 → 4, client-executable WRITERS → 0).** (1) ⚠ **An identifier named `supabase` is USUALLY THE SERVICE-ROLE CLIENT in this repo.** `lib/supabase.ts` exports both (`supabase` = anon, `supabaseAdmin` = service role), but **9+ files import `supabaseAdmin as supabase`**, and several API routes build their own `createClient(url, SUPABASE_SERVICE_ROLE_KEY)` and name it `supabase`. So `supabase.rpc(...)` proves nothing about the effective role, and **"server-side" ≠ "service role"** — resolve the *binding*, never the name. Resolving all of them showed the entire browser/anon + session RPC surface is **two functions**, and `components/**` makes **zero** direct `.rpc()` calls (the browser reaches data through `/api/*` routes). (2) **A direct-caller sweep is NOT sufficient to justify a revoke — check INVOKER-mode callers too.** A `SECURITY INVOKER` function or a `security_invoker=true` **view** executes its callee **as the caller**, so an anon-reachable invoker keeps an anon EXECUTE grant load-bearing even when every *code* caller is service-role. This is why `serial_fmv_estimate` must stay anon-executable (reached via `get_wallet_moments_with_fmv` and the view `topshot_underpriced_serials_board`); revoking on direct-caller evidence alone would have broken the wallet-moments read and a public board. Sweep dynamic `.rpc(var)` sites and direct `/rest/v1/rpc/` fetches as well as literal `.rpc("name")`. (3) **A green drift check says "unchanged since the baseline", NOT "safe"** — the 07-20 baseline accepted 49 rows under one bulk note and an unauthorized writer rode along inside it. `secdef_anon_exec_allowlist` now enforces `secdef_allowlist_note_is_a_real_reason` (note ≥ 40 chars, no `baseline%`), so each acceptance must state which client reaches the fn and why that is safe.

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
- **React components** have a separate jsdom harness (`__tests__/*.test.tsx`, ~156 component test files; ~1,044 test files total under `__tests__/`). They are measured **separately** — deliberately NOT folded into the route/lib coverage number (400+ presentational files would swamp the signal) — and since 2026-07-26 have their **own blocking CI ratchet** (`component-tests` job / `vitest.components.config.ts`, thresholds **70.9/58.45/68.0/74.7** as of 2026-07-31, up from the 20.2/17/19/21.2 it launched at — the 07-28→07-31 component-coverage program climbed the gate ~30→71 st), scoped to the logic-bearing component subtrees so the gate is meaningful rather than drowned in presentational files. **The gate's `include` is an ALLOWLIST, guarded against silent rot** by `__tests__/component-gate-include-completeness.test.ts` (2026-07-31): a new `components/<feature>/` subtree holding logic-bearing `.tsx` must be added to the gate's `include` (+ tested) OR to that test's `KNOWN_UNMEASURED` allowlist with a reason, else the blocking `unit-tests` job reds — closing the hole where an untested new subtree contributed zero to the ratchet until a human remembered it.
- **Deno edge functions are excluded** (no Deno toolchain in CI). Their pure logic is extracted into vitest-importable modules under `supabase/functions/_shared` (`cdc.ts`, `hybrid-custody-parse.ts`, `pack-ev-edition.ts` — incl. `computeDualPrice`, `spork-cursor.ts`) and tested there, with lib↔_shared parity + source-drift guards where a routine has a repo copy. When editing an edge fn, put testable logic in `_shared` and import it.
- **WRITING A NEW `*-deep.test.ts`? Type the mock-state `data` field `as any[] | null` from the start.** The single most repeated CI breakage on this repo: a `vi.hoisted` mock state initialised `data: [] as any[]` (TS infers `any[]`) and then an error-path test assigns `{ data: null, error: {...} }` → `TS2322: Type 'null' is not assignable to type 'any[]'`, reddening the **blocking** `typecheck` job for every concurrent session. It happened **four separate times on 2026-07-25 alone** (`72835ebe`, `d872110`, `c2f53227`, and again hours later), each needing a follow-up repair commit. `tsc --noEmit` is NOT run by vitest, so a green local `npm test` does not catch it — run `npx tsc --noEmit` before pushing a new test file. Same for the sibling `TS2741`: give every mock-result object BOTH `data` and `error`.
- **CI ratchet (do not defeat).** `vitest.config.ts` `thresholds` sit just below the live baseline (2026-07-31: **87.85 stmts / 73.35 branch / 90.7 funcs / 90.35 lines** — raised across the 07-25→07-31 continuation passes from 76.3/61.45/82.0/78.9 at the start of that program, itself up from ~45/37/53/47 at the deep-loop program's start; the full comment history in `vitest.config.ts` records every wave's numbers and what it covered), so a coverage **drop** fails CI while normal noise passes. **Raise these as coverage climbs; NEVER lower them to make a red build pass** — but keep a real ~0.1–0.2 buffer under actuals: on this multi-session repo, concurrent pushes add uncovered code and a zero-margin threshold reds CI on otherwise-green work (lesson `47f901a1`). CI job is `unit-tests` in [.github/workflows/ci.yml](.github/workflows/ci.yml), which runs `npm run test:coverage`.
- **DB-invariant SQL tests (added 2026-07-19 — the layer vitest can't reach).** Plain-SQL tests in `supabase/tests/*.sql` pin the behavior of high-stakes Postgres functions/triggers (guards, normalizers, the destructive-op circuit breaker) that live in the database, not in `lib/`/`app/api/`. Each file is **self-contained**: it creates the minimal fixture tables + a **verbatim copy of the committed function DDL** (between `>>> BEGIN verbatim … >>>` / `<<< END verbatim … <<<` markers), asserts the invariant via `_helpers.sql`, and `ROLLBACK`s — so it runs on a vanilla `postgres:16` (only `unaccent` needed) with **no schema apply** (the repo's migrations are incremental `audit_*` patches over an externally-created base and don't rebuild from scratch; some prod objects were applied via MCP and never committed as files). Run locally: `DATABASE_URL=… bash scripts/run-db-tests.sh`. **When you change a pinned function: edit the migration, then copy the new DDL verbatim into the test file** — the blocking `unit-tests` job runs `__tests__/db-invariants-drift-guard.test.ts`, which fails CI if a test's embedded DDL diverges from its source migration. CI job is `db-tests` (blocking as of 2026-07-19), which provisions a throwaway Postgres from the runner's preinstalled `initdb`/`pg_ctl` binaries on port 5433 (a `services:` container hangs on image pull here). **41 invariants pinned as of 2026-07-31** (the drift-guard tracks all 41; `supabase/tests/` also holds `_helpers.sql`). ⚠ **A pin can go STALE without CI noticing, and the repo cannot detect it — only the live DB can.** The guard compares the test copy to **the migration named in its `PINS` entry**, which is repo-vs-repo; when a function is redefined and applied via MCP *without* a committed migration file, the pin, the test and the guard all stay green while the test validates a definition that no longer runs anywhere. Audited 2026-07-31: **3 of the then-42 pins were in that state** — `promote_unmapped_sales` (~3 months behind), `fmv_clamp_disconnected_ask_topshot` (pinned to a superseded circulation-gated clamp predicate; live is `fmv > med*3 AND fmv > p90*1.5`), `compute_pack_ev_per_edition_weighted` (~2 weeks behind, missing the weighted-median `typical_pull_ev` that the public pack-EV surfaces LEAD with). **The obvious repo-side check — "does the pin name the newest committed migration defining this function?" — catches NONE of them** (for two, the repo holds exactly one defining migration), so do not build it and call it done. The real check is **`npm run db:pins:check`** (`scripts/check-db-pin-staleness.mjs`): it parses `PINS` out of the drift-guard test so the lists can't diverge, reads `pg_proc` for every pinned function, compares bodies under both comment-stripped and comments-included normalization (live `prosrc` is often comment-stripped relative to the file — a cosmetic-only diff is NOT drift), and exits non-zero. It needs `SUPABASE_SERVICE_ROLE_KEY`, so it belongs in a periodic health sweep, not the DB-less `unit-tests` job. Pinned-but-intentionally-undeployed functions sit in its two-way `NOT_DEPLOYED_OK` allowlist (**currently EMPTY**). ⚠ **A pin whose function is GONE should be DELETED, not allowlisted.** `compute_listing_divergence` was allowlisted on 07-31 and deleted hours later the same day: `pg_proc` (all schemas) 0, referencing function bodies 0, views 0, `cron.job` commands 0, zero in-repo callers — retired with Flowty. Its SQL test created its own copy of the function, so it passed unconditionally: a test that *cannot* fail asserts nothing, and the allowlist entry then has to be maintained and re-read by every future pin auditor in exchange for zero coverage. Reserve `NOT_DEPLOYED_OK` for a function genuinely pending deployment. **Repointing a stale `PINS` entry is only half the repair — re-read the test's ASSERTIONS**, which by then describe behaviour production has stopped exhibiting (the 07-31 clamp test asserted a circulation gate that no longer exists; the pack-EV test asserted `ev_basis='original'` for a Top Shot pool that live forces to `remaining`). Docs: `supabase/tests/README.md`.
- **Cadence tests** — `npm run test:cadence` extracts inline Cadence (`scripts/extract-cadence.mjs`) and runs `flow cadence lint` against `tests/cadence/fixtures/`. Gated in CI (`cadence-lint` job, needs `flow dependencies install`). See `docs/cadence-testing.md`. Separately, a real `flow test` suite exists for the (undeployed) RPCTradeEscrow contract at `cadence/tests/RPCTradeEscrow_test.cdc` — **16/16 green**, all 12 audit scenarios covered — run locally via `npm run test:cadence:escrow` (fetches deps via `scripts/fetch-cadence-escrow-test-deps.sh` first) and **now run in CI** as of 2026-07-19 (`cadence-escrow-tests` job installs flow-cli from master + fetches pinned ExampleNFT v1.2.2; one-time local setup in `cadence/tests/README.md`).
- **CI jobs (8, all in [.github/workflows/ci.yml](.github/workflows/ci.yml)):** `typecheck` (`tsc --noEmit` over the whole repo incl. `__tests__`), `cadence-lint`, `cadence-escrow-tests`, `unit-tests` (vitest + coverage ratchet + the DDL drift guard), `component-tests` (the jsdom component-coverage ratchet — `npm run test:coverage:components` over `vitest.components.config.ts`, thresholds **70.9/58.45/68.0/74.7** as of 2026-07-31, added 2026-07-26 in `c3c86427` at 20.2/17/19/21.2 and climbed by the component-coverage program; also guarded by the include-completeness rot-guard, see the React-components bullet above), `db-tests` (SQL invariants), `ledger-guard` (fails a push that DROPS or REMOVES any `docs/overnight/ledger.md` entry — it compares the `^### ` heading **sets** between `HEAD~1`→`HEAD`, not just counts, so a same-count remove-one/add-one swap is caught too, after commit `2966c0a` defeated the count-only check on 2026-07-19; opt out of a legitimate archival roll with `[ledger-roll]` in the commit message), and **`edge-deno`** (added 2026-07-29; `deno check` + informational `deno lint` over `supabase/functions/**` — the ONLY thing type-checking the Deno edge source, which the vitest/tsc jobs exclude. **NON-BLOCKING** (`continue-on-error`) — **16 `deno check` errors remain** (down from 21; the `_shared/cdc` "cannot find module" class was fixed 2026-07-31 by adding `--unstable-sloppy-imports` to the check). **ROOT-CAUSED 2026-07-31 (CI-tested both ways):** the 16 are a toolchain conflict, NOT edge-source bugs — `--node-modules-dir=auto` is required (the SDK's type-only `import "@supabase/functions-js/edge-runtime.d.ts"` drags a transitive `npm:openai` dep that only resolves in node_modules mode) but that mode rejects that jsr-**subpath** import (×12) + the `std/http/server.ts` **URL** imports (×2) as `TS2307 "not a dependency"` (+2 `TS7022` cascades). Remapping the subpath `jsr:`→`npm:` was TESTED and did NOT help. **The real fix (deploy-verify session): delete the 12 type-only `edge-runtime.d.ts` imports → drops the openai dep → then drop `--node-modules-dir=auto` → std/URL imports + cascades resolve → drop `continue-on-error` to promote.** Full playbook: [docs/handoff-2026-07-30-deno-edge-ci.md](docs/handoff-2026-07-30-deno-edge-ci.md)). **Edge fns now import deps by BARE specifier via the `supabase/functions/deno.json` import map — new edge code must not use inline `https://esm.sh`/`jsr:` URLs.**

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
- **Vercel crons** — 33 entries in [vercel.json](vercel.json) (verified 2026-07-28 — down from 34 after commit `36cd2acd` retired the dead `sync-sales-ingest-dune` schedule, which had run 36 times with 0 ok since activation, its `DUNE_SALES_INGEST_QUERY_ID` bake never having taken; the route is KEPT, only the schedule removed, mirroring the `evm-transfers-ingest`/`drain-base-parallel-probe` dispositions. 34 was itself down from 35 after `692da543` retired the drained Population-B `drain-base-parallel-probe` schedule. The two newest remaining are the 07-25 AllDay residue drains — `allday-price-recover` at `/api/admin/recover-v1-budget-exhausted` `*/20 * * * *` + `allday-resolve-unmapped-tail` `40 */3 * * *`; before them `candy-listings-indexer` `35 */3 * * *` from the 07-24 Candy parity build; others `allday-lock-refresh-batch` `23 * * * *`, `candy-offers-indexer` `50 */6 * * *`, and the remaining Dune walker `sync-sales-seller-recovery-dune` `47 * * * *` — still **INERT** pending `DUNE_SALES_SELLER_QUERY_ID=8027085`) (`maxDuration` ≤ 800; pack-grail-MV refresh, rip-metadata backfill, misattribution drain, `/api/cron/warm` business-hours warmer, ownership-sync-dune, …).
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
- `badge_editions.low_ask` coverage gap — **AllDay RESOLVED (verified 2026-07-17), the cron this note asked for is LIVE.** `allday-badge-low-ask-refresh` (pipeline_runs, `nfl_all_day`, every 30 min, ok=true, ~3,800 rows/refresh) now keeps AllDay at **3,897/5,607 (69.5%), fresh same-day** — the old "0/1572 always NULL" is stale; do NOT build a second AllDay cron. TopShot healthy and fresh (1,929 low_ask + 1,929 offers; the pct fell to ~28% only because the badge-set backfill grew the row count 2,987→6,930, not a regression). **Golazos low_ask RESOLVED (verified live 2026-07-27, supersedes the "111/218, no pipeline, UNIDENTIFIED" note this bullet used to carry).** The `golazos-badge-low-ask-refresh` cron IS live and healthy (pg_cron `10,40 * * * *`, last run `succeeded`; SECDEF `refresh_golazos_badge_low_ask()` self-heals `edition_id` via `resolve_golazos_listing_edition_ids()` then reads `golazos_edition_floor_ask`), holding Golazos at **81/218 low_ask, fresh same-hour**. The 37% ceiling is **listing-gated** (only editions with a live Flowty floor get a `low_ask`), not a bug — do NOT build a second Golazos low_ask cron. **The one genuinely-open Golazos gap is `highest_offer` 0/218:** unlike `low_ask` (which the refresh fills), `highest_offer` is fed by the offers pipeline (`edition_offers`), and `edition_offers` holds **ZERO Golazos rows** — there is no Golazos offer source at all. Filling it therefore requires a NEW Golazos offers indexer (a DapperOffersV2 sweep), a real ingest project, not a refresh tweak — operator/ingest call, not autonomous. **STAGED 2026-07-28 (inert, pending one on-chain recon):** `app/api/golazos-offers-indexer/route.ts` (mirror of the live `allday-offers-indexer`) + `golazos_open_offers` table are committed but **uncronned** — the gate is whether Golazos OffersV2 offers are EDITION-type (unverifiable from the cloud sandbox: no Flow REST egress). One authenticated POST from prod settles it; see [docs/handoff-2026-07-28-golazos-offers-indexer.md](docs/handoff-2026-07-28-golazos-offers-indexer.md).

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

3. **Trade Hub — SHELVED (2026-06-01), same class as Cart #1.** On-chain trade escrow (`RPCTradeEscrow`) is not deployed; the 5 submitters in [lib/trade-escrow/fcl-submit.ts](lib/trade-escrow/fcl-submit.ts) were returning fake `0xstub_` tx ids, implying swaps that never happened. Guarded 2026-06-01: each submitter calls `ensureLive()` (throws unless `RPC_TRADE_ESCROW_ADDRESS` is set); the live routes `/api/trade-chain/{propose,execute,deposit-callback,cancel-callback}` + `/api/admin/reclaim-expired-trades` return 503 "Trade Hub is not available yet."; `/dashboard/trade-hub` `notFound()`s via a server gate (split into `TradeHubClient.tsx`). The wishlist/offers/matches CRUD (`/api/trade-hub/*`) is untouched. To re-enable: deploy the contract, set `RPC_TRADE_ESCROW_ADDRESS`, and replace each stub body with the real `fcl.send` per the file's NEXT_STEPS + `RPCTradeEscrow_DEPLOYMENT.md`. Revert the guard: `git revert`. **Update 2026-07-17:** the contract now has a green `flow test` suite (`cadence/tests/RPCTradeEscrow_test.cdc`, 16/16, all 12 audit scenarios + 4 bonus properties), and two latent compile blockers were fixed in the still-undeployed contract (`Trade.execute()` → `settle()` — `execute` is a hard keyword in Cadence ≥1.0 — and the NonFungibleToken import switched to string form). Shelve status unchanged. **Update 2026-07-25 (Claude Code):** completed the panel's Cancel TODO — new `/api/trade-chain/cancel-callback` route (mirrors `deposit-callback`: 503 while shelved, else party-check + status→`cancelled` + `cancel_tx_id`) + client stub `lib/trade-escrow/sign-cancel.ts` (mirror of `sign-deposit.ts`) + `TradeChainPanel.onCancel` now calls it (was console-log-only). Shelve status STILL unchanged — route 503s and the page `notFound()`s in prod. **Update 2026-07-31 (Claude Code, Trevor-directed):** the 5 `fcl-submit.ts` submitters AND the 2 client sign helpers (`sign-deposit.ts`/`sign-cancel.ts`) are now WIRED FOR REAL — the "replace each stub body with real fcl.send" instruction above is DONE. New `lib/trade-escrow/cadence.ts` holds 5 address-injected FCL transaction templates (deposit is ONE universal template over the generic `NonFungibleToken.Provider`/`Receiver` since the contract validates NFT type/ids on-chain); server verbs `fcl.mutate`+`onceSealed` (throw on sealed-with-error) signed by the RPC hot wallet via the verified `lib/breaks/server-authz` authz; client verbs user-wallet `fcl.mutate`. **Shelve status STILL unchanged — INERT in prod:** `ensureLive()` still throws unless `RPC_TRADE_ESCROW_ADDRESS` is set, the routes still 503, the page still `notFound()`s. ⚠ **UNVERIFIED + UNTESTED ON-CHAIN** — `RPCTradeEscrow` is not on Flow mainnet, so the mandated Cadence-MCP-against-mainnet verification could not run; templates are correct-by-construction against the in-repo contract source + the 16/16-green `flow test` templates + the production NFT-standard Cadence in `break-transactions.ts`, but **MUST be testnet-dry-run for all 5 verbs before go-live**. Go-live now needs TWO envs (the server-only `RPC_TRADE_ESCROW_ADDRESS` is not visible in the browser): `RPC_TRADE_ESCROW_ADDRESS` (server) + `NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS` (client, same value). `RPCTradeEscrow_DEPLOYMENT.md` referenced above does NOT exist in the repo — the grounding sources are the ones just listed. Tests: `__tests__/trade-escrow-{cadence,fcl-submit,sign-deposit,sign-cancel}.test.ts`. Revert: `git revert <sha>` restores the honest stubs.

4. **Pinnacle FMV — RESOLVED (verified 2026-05-24; table renamed 2026-06-08, re-verified 2026-06-28).** The "0 FMV editions" claim was stale. Pinnacle FMV is RENDER-keyed and lives in its own `pinnacle_fmv_history` table (cols: `render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at`; ~13.4k history rows, ~1.8k renders priced in 2d), recomputed daily by engine `pinnacle-2.0.0-render` and propagated to `wmc` hourly by `populate-pinnacle-wmc-fmv`. Pinnacle ASK comes from `pinnacle-listings-indexer` (direct-chain), not Flowty. CRITICAL: Pinnacle FMV lives in `pinnacle_fmv_history`, NOT the uuid-keyed `fmv_snapshots`; the old `pinnacle_fmv_snapshots` table was DROPPED 2026-06-08 (survives only as `pinnacle_fmv_snapshots_backup_20260608`) so a query against `pinnacle_fmv_snapshots` now 42P01-errors.

7. **AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25.** The earlier "historical spork scan" framing was wrong: the backlog is not spork-era data. All 2,550 NFL All Day unmapped rows are under 6 weeks old and were starved by the resolver running at `batch_size: 5` against a Flowty-only lookup. Fixed by the GQL-primary edge-function rewrite + `batch_size 5→200` bump in the 2026-05-25 (latest) session above. The Pinnacle side is separately covered by the direct ASK pipeline (Phase 2C, 2026-05-11). The `spork-proxy` worker remains live for any genuinely spork-era investigation but no longer blocks the unmapped-sales backlog.

9. **Storefront audit pipeline — RETIRED (verified 2026-05-24).** It is a manual script (`scripts/scan-historical-storefront.mjs`), not a deployed cron or route — not monitored, not read by any frontend code. Cold since 2026-04-28 simply because nobody runs the script. De facto retired; no operational action. `storefront_audit_wallets` (5,365 rows, tiny) is harmless — optional drop candidate.

   **Storefront-cleanup machinery removed (2026-06-03).** The manual listing-cleanup chore (`scripts/cleanup-storefront-wallets.mjs` → root `cleanup.cdc`, which shelled `flow transactions send cleanup.cdc <addr> --signer my-account` gas-paid by the Cadence payer wallet `0x73f55c4450b8d466`) was the sole FLOW drain on that wallet, and it cleaned only dead storefronts (tied to the TS listings-indexer retired 2026-05-26 + Flowty shut 2026-05-13) — zero product value, since no live surface (FMV / analytics / insights / concierge / pack-EV — all reads + Supabase) draws on it. Both files were deleted to make the drain impossible to restart from the repo. **The payer wallet `0x73f55c4450b8d466` is intentionally empty and its `cadence-payer-balance-check` cron is paused** while all Cadence-write features (breaks / Cart / Trade Hub) are shelved (the `breaks` schema `20260509120000_breaks_schema.sql` is UNAPPLIED in prod). The `/api/cron/cadence-payer-balance-check` route is left dormant (not deleted) for easy revival. **To revive:** fund the wallet >0.05 FLOW + un-pause the cron-job.org entry. If `cleanup`/`flow` txns keep appearing on Flowscan from this wallet with no human at the keyboard, an out-of-repo scheduler (OS cron / Task Scheduler / launchd) is still alive — kill it as part of the Flowty teardown. Ledger cross-ref: N3.

10. **`/dashboard` token migration** — `app/dashboard/page.tsx` ~1,750 lines. Big lift, defer until stable.

11. **Brand punch list — partial.** Per-feature OG cards exist (`/api/og/{collection,deal,moment,pack,profile,fast-break,default}`). Still missing: the `/home-fmv-preview.png` home screenshot. Fast Break / RTR / admin tokenize once stable.

12. **Blazers trivia** (`lib/blazers-trivia.ts`) — 29 items shelved, still no UI.

14. **Monolith page refactor — Phase 1 COMPLETE across all three targets (verified 2026-07-27).** Every leaf component / type / constant / helper is already extracted into its own module, so the flagged files are far smaller than the May plan's snapshot: `collection/page.tsx` **~1,600** (was 2,900), `sniper/page.tsx` **~1,705** (was 2,485), `analytics/page.tsx` **~1,754** (was 2,203). What remains is **Phase 2** — breaking up the main interactive component in each (`WalletMomentsBody` on collection, the feed component on sniper) into per-`useState`-cluster children — which the plan flags as **medium-risk and requires rendered-DOM validation across all 5 collections; do NOT attempt it in one commit**. Pure, unit-testable logic can still be peeled off safely (e.g. `collection/page.tsx`'s CSV export → `lib/collection/export-csv.ts`, 2026-07-27). Plan in `docs/audits/refactor-plan-monolith-pages-2026-05.md`.

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
