# Rip Packs City — Project Health Report

**Date:** 2026-06-29
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Cross-session Safety §, Recent Sessions §), `docs/overnight/ledger.md` + `docs/overnight/metrics-latest.json` (live autonomous-pass state, last captured 2026-06-28T08:06Z) + `docs/overnight/focus.md` (last interactive focus, 2026-06-24), a gitignore-aware `TODO/FIXME/HACK/XXX` scan of the source tree, and `git log` (available and reliable this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-06-22.md` (7 days ago). This regeneration mirrors its structure. `_2026-06-15.md`, `_2026-06-08.md`, `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all nine reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-06-22 — a pack-EV-honesty + data-completeness + safety-hardening week.** **157 commits since 2026-06-22** (≈59 code-bearing: 31 `feat` / 24 `fix` / 3 `perf` / **1 `refactor`**; the rest process/automation: 48 `docs` / 27 `monitor` / 9 `chore` / 5 `night pass` / 4 `ops` / 3 `overnight` / 2 `daytime monitor`). Four headline stories: **(1) Pack-EV reality calibration — the week's main product push.** A four-commit program (`c688f67` → `94863cc` → `5ee2574` → `c493532`) reframed pack expected-value around *observed reality* rather than model output: a reality-adjusted EV headline, a model-vs-reality board, observed pack lifecycle, a "value still sealed vs pack price" headline, and edition-level pack provenance. This is the most direct "be more useful than Top Shot's own site" work in weeks and advances both Prioritized Action #2 and the long-running Pack-page tune-up (#17). **(2) A deep-history sales-backfill program across every collection.** A shared studio-platform GQL drain (`77f0c65`) plus per-collection backfills landed historical secondary-sales coverage for AllDay (`7be31e3`), Golazos, Pinnacle (`11c8a23`), UFC (`3573f56`), and the TS-Flowty tail (`98c35dc`) — external-id/render-keyed so they write **zero** `unmapped_sales` and keep edition counts flat. This is FMV-completeness infrastructure: more sales history → better FMV confidence. **(3) Cross-session safety hardening went LIVE.** A statement-level destructive-op circuit-breaker (`rpc_guard_block_destructive`, `611b2fb` family) now blocks bulk/cross-cutting deletes on irreplaceable tables (born from a 2026-06-27 incident that blind-deleted 1,724 cache rows); per-collection FMV-freshness tripwires were added to `v_rpc_trust_health` (**trust-health 9/9 → 13/13**); and a concurrency guard + GHA backstop was added for the wallet-backfill / snapshot writer families. **(4) Two new inert chain scaffolds.** A Dune-backed TopShot ownership index (Pipeline A, `e75f6c3`, inert until provisioned) and a Panini WC2026 Prizm "Plane-A" ingest scaffold (`ec82db1`, repo-only, nothing live) — the latter is the source of a new 10-marker TODO cluster (§5h).

> **Plus continued intelligence + activation work:** **3 new public `/insights` surfaces** (`rookie-board`, `new-collectors`, `allday-scarcity`) — the hub is now **21 surfaces** (was 18), each with its own dedicated OG card (per-surface insights OG routes 17 → 20); **real per-moment NFL All Day badges** via a residential-Atlas ingest (`e56e4e3`); the alerts UI gained type-to-fill chip pickers / typeahead for player/set/team/collection/tier/parallel filters (`716566b`, `3e96f44`); AllDay + Pinnacle FMV now replicate the Top Shot ASK_ONLY structure where there's no LiveToken (`9056eff`); and a loud concierge model-retirement guard (`20d75a2`) closes the class of bug that silently broke the on-site concierge for ~7 days in June.

> **Security / safety improved measurably this week.** Beyond the destructive-op guard: a defense-in-depth migration (`audit_20260623_revoke_dormant_anon_dml_defense_in_depth`) revoked the dormant Supabase-default anon INSERT/UPDATE/DELETE grants on 147 tables — **anon write grants 482 → 46** — preserving only the five intentional anon-write tables (`email_subscribers` / `outbound_clicks` / `portfolio_snapshots` / `support_conversations` / `funnel_events`). `check_public_security_invariants()` stayed **0** throughout (the revoked grants were unreachable — RLS already blocked them — so no behavior change).

> **Traction reality (carried forward — no fresh user-count snapshot this run).** The last logged traction read (2026-05-31, ledger) was **~13 total users, 0 signups in 7 days, 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** No signups-moved-off-zero measurement appears in this week's commits. Monetization remains tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation* and *measurement* of the surfaces already built (now including the omni-channel alerts loop shipped two weeks ago, still at **1** subscription: Trevor's own go-live test). **Cost** remains the one concrete financial pressure (the carried Vercel cost family); additionally, the deep-history backfill wave pushed the **DB to 6,391 MB** (up ~1.3 GB from last week's ~5,090 MB) — benign per the night pass, but a storage/cost line worth watching.

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — Flowty-dependent infra is frozen; the teardown DECISION is "keep frozen, close Priority #1" (`docs/cleanup-decisions-2026-06-01.md`). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and pack-EV are historical-only. **(3) Chain-two (Candy / Solana) prebuild landed inert (06-08)** and remains gated on a **July-8 Candy data tripwire** — not started early. It is the source of the 17-line Candy/Solana discovery-placeholder TODO block (§5g). **(4) NEW: a Panini WC2026 Prizm Plane-A ingest scaffold landed inert (06-26)** — repo-only, writes nothing, gated on a per-mode discovery capture (§5h).

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **absent right now = no freeze active.** The night pass is pushing reliably; the 06-28 genuine-overnight pass shipped **0** production changes (a correct "green night") and verified the dense 06-27 daytime wave all-PASS. **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md` since last week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Net-new shipped features (not numbered) | **9** | Pack-EV reality calibration (NEW); Omni-channel alerts (LIVE, 1 sub); Rewards points economy (DIAL-IN); AllDay per-moment badges (NEW); **3 new `/insights` surfaces** (rookie-board / new-collectors / allday-scarcity); AllDay+Pinnacle ASK_ONLY FMV structure; the inert Candy chain-two prebuild; the inert Panini WC2026 Plane-A scaffold — §2.2 / §2.3 |
| Open overnight operational items | **~8 active + ~4 deferred** | Carried: **VERCEL cost family**; ALLDAY-V1-UNMAPPED-DRIFT; THIN-FMV-GUARD-CONTENTION; topshot-sales-history-backfill watchlist; `refresh-conflated-editions` cron (operator); PIN-FMV-REKEY waves 2/3; PIN-SYNC-CRON; A1-WORKER-PASSTHROUGH-CLEANUP. Deferred: WEEKLY-SURFACE-QA-PROSE, ANALYTICS-SMOKE leg-opt, IPFS ×2 — see §2.6 |
| Net-new structural workstream | 3 | Multi-chain chain-abstraction (Phases A–F complete; 18 shim TODOs) + the inert Candy/Solana chain-two prebuild (17 TODOs) + the NEW inert Panini WC2026 Plane-A scaffold (10 TODOs) (§2.8) |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; Priority #1 (Flowty) recommended-closed (keep frozen). Activation-measurement + cost-right-sizing still arguably belong here. |
| In-code TODO markers | **66 real lines / 38 files** (+3 false positives) | **+10 vs last week's 56.** All ten new markers are the inert Panini WC2026 Plane-A scaffold (§5h) — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** Another *correctness-and-trust-led* week, of the kind that quietly raises the product's credibility rather than its user count. Three of the four headline stories are infrastructure for trust: pack-EV reality calibration (so the EV numbers stop over-promising), the cross-collection deep-history sales backfill (so FMV has the sales it needs), and the live destructive-op circuit-breaker + per-collection FMV-freshness tripwires (so a single-collection FMV outage or an errant bulk delete pages immediately instead of corrupting silently). The one genuinely new user-facing surface is the pack-EV reality board and the three `/insights` additions. Operationally the platform reads GREEN (per `metrics-latest.json`, 2026-06-28: security **0/0/0/0**, **trust-health 13/13** with breaches `[]`, `detect_stalled_pipelines()` / `check_pgcron_recent_failures()` / `get_pipeline_alerts()` all empty, FMV improving and reconciling, editions flat, `ts_wmc_uuid_fossils` driven to **0**, Sentry **0** unresolved/24h). The dominant concern is unchanged: **activation/traction** (≈13 users at last read, with even more live-but-unmeasured machinery now). Descending, concentrated code-quality risk: **(1)** the FMV-correctness tails (Pinnacle per-render waves 2/3; the deep-history backfill convergence); **(2)** cost/storage right-sizing (the carried Vercel cluster *plus* the +1.3 GB DB growth from the backfill wave); **(3)** the chain-foundation cleanup tails (18 chain-rename shims + 17 Candy + 10 Panini intentional TODOs). Monolith refactors, brand polish, and the page tune-up remain secondary.

### Themes

| Theme | Items |
|---|---|
| Data-intelligence correctness (a headline this week) | Pack-EV reality calibration (reality-adjusted headline + model-vs-reality board + observed lifecycle + pack provenance); cross-collection deep-history sales backfill (AllDay / Golazos / Pinnacle / UFC / TS-Flowty); AllDay+Pinnacle ASK_ONLY FMV structure; real AllDay per-moment badges; UFC/Golazos media + DQ fills (§2.3) |
| Conversion / activation (the real critical path) | **Omni-channel alerts (LIVE, 1 sub)** + new type-to-fill filter UI; Rewards economy (DIAL-IN); **3 new `/insights` surfaces** (rookie-board / new-collectors / allday-scarcity). **Verify `funnel_events` accumulates; measure whether signups / alert sign-ups move off zero.** (§2.1) |
| Safety / reliability hardening (NEW headline) | Destructive-op circuit-breaker (`rpc_guard_block_destructive`); per-collection FMV freshness in `v_rpc_trust_health` (trust 9/9 → 13/13); concurrency guard + GHA backstop for wallet-backfill / snapshot writers; table-driven sentinel thresholds (§2.4) |
| Security / dependency hygiene | Defense-in-depth anon-DML revoke (482 → 46 anon write grants); `next` / `eslint-config-next` hold at **16.2.9**; concierge model-retirement guard. 4 residual transitive HIGHs are the onflow→viem→ws chain (monitor-only). (§2.4) |
| Cost / operational right-sizing (carried + growing) | Vercel cost family carried (no new invoice logged); **DB grew ~1.3 GB** (deep-history backfill wave) — storage/cost watch. (§2.6) |
| Operational / overnight queue | Vercel cost cluster; ALLDAY-V1-UNMAPPED-DRIFT; THIN-FMV-GUARD-CONTENTION; topshot-sales-history-backfill watchlist; `refresh-conflated-editions` cron (operator); PIN-FMV-REKEY waves 2/3 + PIN-SYNC-CRON; A1-WORKER-PASSTHROUGH-CLEANUP; ANALYTICS-SMOKE leg-opt; IPFS deferrals (§2.6) |
| Multi-chain foundation | Chain-abstraction Phases A–F complete (18 shim TODOs); Candy/Solana chain-two prebuild inert (17 TODOs); **NEW Panini WC2026 Plane-A scaffold inert (10 TODOs)** (§2.8 / §5a / §5g / §5h) |
| Tech debt / refactor | `/dashboard` migration (#10, **2,149 lines**, flat); monolith pages (#14 — collection **2,867** (DOWN ~71), sniper **2,166** (flat); the analytics figure in `CLAUDE.md` remains stale, see §8) |
| Page polish | Pack/Moment/Set tune-up (#17 — pack-EV reality board + edition pack provenance landed this week); brand punch list (#11 — light-mode wave complete); Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded); Cart (#1, shelved by decision); A1 special-serial owner lookup (blocked at the TS API edge) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id` migration; `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

Intelligence-first with revenue shelved by decision. This week the intelligence-correctness + safety work led; activation still leads what's *next* (the machinery exists and needs measurement), paired with the carried-and-growing cost right-sizing.

### 2.1 Conversion / activation — machinery built (incl. a live alerts loop), still unmeasured — `Severity: High · Effort: Medium (shipped, unmeasured)`

The funnel has been open for weeks; this week added discovery surfaces and polished the alerts UI:

- **3 new public `/insights` surfaces** — `rookie-board` (per-parallel FMV / burn / lock for the 2025 rookie class), `new-collectors` (acquisition funnel + cohort retention), and `allday-scarcity` (NFL All Day scarcity board). All three shipped with the full server-render / OG / canonical / sitemap treatment; the hub is now **21** (see §2.2).
- **Alerts UI polish** — type-to-fill `OptionTypeahead` for collections / tiers / parallel filters (`3e96f44`) and a type-to-fill chip picker for player / set / team filters (`716566b`). Reduces friction on the one true engagement loop. **Omni-channel alerts remain LIVE with 1 active subscription** (Trevor's go-live test); the next step is still to open it to the allow-list and watch sign-ups. **Known limitation (carried):** serial / jersey / last-mint / never-sold filters enforce at the *edition* level until a per-serial live-listing feed lands.
- **Rewards points economy** (live, carried, status **DIAL-IN**) — store stocking still awaits Trevor's Moment picks; raffle still held pending legal review. No code blocker.

Suggested next step (unchanged and still the highest-leverage work): confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop AND the alerts loop (sign-ups, channel links, deliveries); open alerts to the allow-list. Then watch whether signups move off zero. Worth promoting to an explicit `CLAUDE.md` prioritized action.

### 2.2 Public intelligence surfaces — expanded to 21 — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2.

- **`/insights` hub — now 21 surfaces** (verified against `INSIGHT_ROUTES` in `app/sitemap.ts` and the `app/insights/` dir): `squeeze`, `pack-reality`, `pack-sniper`, `rookies`, `rookie-board`, `first-mint`, `cross-collection`, `set-squeeze`, `pinnacle-scarcity`, `allday-scarcity`, `market`, `offer-spread`, `deals`, `trophies`, `top-sales`, `serial-premiums`, `new-collectors`, `underpriced-serials`, `pack-drops`, `squeeze-check`, `tc-report`. **+3 this week** (`rookie-board`, `allday-scarcity`, `new-collectors`).
- **Pack-EV reality board** (06-27/28) — the pack pages now surface an observed pack lifecycle, a model-vs-reality EV board, a reality-adjusted EV headline, and "value still sealed vs pack price." See §2.3.
- **OG cards** — **14 top-level routes** (`collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `share`, `team`) **plus 20 per-surface `/api/og/insights/*` cards + 1 shared fallback** (only `tc-report` uses the fallback). The per-surface insights OG surface grew 17 → 20 (matching the 3 new surfaces).

No open defects tracked here; listed because it is a large body of *shipped* product work.

### 2.3 FMV / data-intelligence correctness — the week's main event — `Severity: was High (correctness) · Effort: large, mostly landed`

- **Pack-EV reality calibration (06-27 → 06-28).** A four-commit program reframed pack expected-value around observed reality: `c688f67` (observed lifecycle + EV reality-check), `94863cc` (value-still-sealed vs pack-price headline), `5ee2574` (calibrated EV estimate), `c493532` (reality-adjusted EV headline + model-vs-reality board + edition pack provenance). The supporting attribution work (`v_topshot_pack_lifecycle` / `v_topshot_pack_realized_ev`) was verified all-PASS in the 06-28 post-ship watch. This is the most direct "be more trustworthy than Top Shot's own marketing" work in weeks.
- **Cross-collection deep-history sales backfill.** A shared studio-platform GQL drain (`77f0c65`, `lib/studio-sales-history.ts`) plus per-collection backfills landed historical secondary-sales coverage: AllDay (`7be31e3`, 2023-11+), Golazos, Pinnacle (`11c8a23`, pre-2026-launch tail), UFC (`3573f56`, 2022+ tail), and the TS-Flowty unmapped backlog promoted into sales (`98c35dc`); the spork-proxy historical floor was extended to mainnet17 / 2022-04-06 (`59ddb6b`). All external-id/render-keyed ⇒ **zero `unmapped_sales` writes, editions flat, perfect dedup** (the safety property the on-chain backfills can't give). This is FMV-completeness fuel: ~124k+ studio sales ingested in the wave.
- **AllDay + Pinnacle ASK_ONLY FMV structure (`9056eff`).** Replicated the Top Shot ASK_ONLY confidence structure for AllDay + Pinnacle (which have no LiveToken), so editions with asks-but-no-sales are labelled honestly rather than NO_DATA.
- **Real AllDay per-moment badges (`e56e4e3`).** Replaced placeholder/edition-level badges with real per-moment NFL All Day badges via a residential-Atlas ingest.
- **DQ + media fills.** UFC `video_url` recovered on-chain 518/518 (`0ae1b26`); 72 UFC null `set_name` filled from on-chain `UFC_NFT` setData (`729bfe4`); Golazos `video_url` recovered from the thumbnail key.
- **Pinnacle per-render FMV (PIN-FMV-REKEY).** Carried — the per-render engine (`pinnacle-2.0.0-render`, table `pinnacle_fmv_history`) is primary; **a docs-only fix this week** corrected a stale `CLAUDE.md` reference that still named the dropped `pinnacle_fmv_snapshots` table (a live-query footgun). **Remaining (Trevor-sequenced): waves 2/3** then retire any legacy readers.

Suggested next step: watch the deep-history backfill converge and keep `v_fmv_sanity_flags` + the new per-collection `*_fmv_stale_hours` tripwires in the weekly health check; finish PIN-FMV-REKEY waves 2/3; let the pack-EV reality board soak and confirm the realized-EV views stay fresh.

### 2.4 Safety / reliability + dependency hygiene — `Severity: Medium (improved) · Effort: mostly done`

This week materially hardened the platform's safety floor:

- **Destructive-op circuit-breaker — LIVE.** A statement-level trigger (`rpc_guard_block_destructive`, thresholds in `rpc_delete_guard_config`) now BLOCKS bulk/cross-cutting deletes on irreplaceable tables (`wallet_moments_cache` spanning >3 wallets, `editions` >25 rows, `pinnacle_editions` >25 rows, any TRUNCATE on those). Routine scoped deletes pass untouched; a genuinely-intentional bulk delete must opt in inside the txn (`SET LOCAL rpc.allow_bulk_delete = 'on'`). Born from a 2026-06-27 incident where a session blind-deleted 1,724 `wallet_moments_cache` rows.
- **Per-collection FMV freshness — LIVE.** `v_rpc_trust_health` now carries `topshot/allday/golazos/ufc_fmv_stale_hours` (breach 6/12/30/30h) alongside `pinnacle_fmv_stale_hours`, so a single-collection total-FMV outage pages directly (the old global freshness check masked it). This is why **trust-health moved 9/9 → 13/13** (more checks, all green).
- **Concurrency guard + GHA backstop (`611b2fb`)** for the wallet-backfill / snapshot writer families (`pipeline_run_locks`) — stops two concurrent lambdas self-contending.
- **Table-driven sentinel thresholds (`0a684d2`, `sentinel_threshold_config`)** — sentinel breach levels are now config rows, not hardcoded.
- **Security defense-in-depth (`audit_20260623_revoke_dormant_anon_dml_defense_in_depth`).** Revoked dormant anon INSERT/UPDATE/DELETE on 147 tables — **anon write grants 482 → 46** — preserving the five intentional anon-write tables; `check_public_security_invariants()` stayed **0** (no behavior change, the grants were unreachable).
- **Concierge model-retirement guard (`20d75a2`).** A loud guard + `model_error` class so the next Anthropic model retirement pages immediately instead of silently breaking the on-site concierge (it broke for ~7 days in June behind a generic fallback).
- **Dependencies hold at `next` / `eslint-config-next` 16.2.9** (last week's security bump clearing the App-Router middleware/proxy-bypass CVE relevant to `proxy.ts`). The 4 residual transitive HIGHs (`defu`/`fast-uri`/`ws`/`viem` via the onflow chain) stay **monitor-only** — their only fix path is a build-breaking `@onflow/*` bump. `stripe@^22` present but dormant (monetization tabled).

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

Carried from the 06-22 asset audit (special-serial-owners MV refresh on `pg_cron`; spent one-off tasks deleted; `rpc-data` skill predicate fixed + `rpc-artifact-ops` skill installed). This week's overnight/monitor passes continued routine hygiene: drained inbox files, archived spent inbox entries, refreshed `metrics-latest.json`, and the 06-28 night pass corrected the stale `pinnacle_fmv_snapshots` table-name footgun in `CLAUDE.md` (docs-only). Artifacts: 13 active in the manifest, none flagged broken or repaired this week.

### 2.6 Overnight operational queue — cost-led, plus the carried data/ops tail — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue this week is dominated by carries; the data-correctness work closed its own items as it shipped. **Closed/resolved since the last report:** TS-WMC-UUID-FOSSILS (on-chain re-key 1,748 → 0), ALLDAY-FMV-POPULATE-NOOP-STALL, the Pinnacle-FMV table-name footgun, PACK-EVENTS-CRONJOB-STALL + LISTCACHE-CRON-DROP (Trevor code-fixes), UFC-EDITIONS-SEED-GAP (seeded), UFC-VIDEO-RLS, and the two pack/rookie/new-collectors insights-QA items. Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **VERCEL cost family** | Carried (FLUID-RIGHTSIZE, CRON-CADENCE, SPEND-PAUSE backstop, OBSERVABILITY-SAMPLING, FLUID-CONCURRENCY). No new invoice figure logged. **Now compounded by ~1.3 GB DB growth** from the deep-history backfill wave (5,090 → 6,391 MB). | Med | Mostly Trevor (dashboard) + operator. The SPEND-PAUSE backstop (set a monthly cap) is the do-regardless one. |
| **ALLDAY-V1-UNMAPPED-DRIFT** | Open AllDay `unmapped_sales` are `source=onchain_dapper_v1` (`v1_tx_decode_budget_exhausted`); correctly held out of `sales`. Resolver healthy post-fix; the hard tail is unresolvable. | Low | Operator: classify the residual as permanent or wire the recover cron. |
| **THIN-FMV-GUARD-CONTENTION** | `rpc-refresh-thin-fmv-guard` occasionally times out under a 13:30Z micro-contention window. | Low | CC: planner/timeout fix if it recurs. |
| **topshot-sales-history-backfill watchlist** | The older GHA edition-queue backfill not yet on `pipeline_cadence_watchlist`. | Low | Night pass: watchlist after banked cadence. |
| **PIN-FMV-REKEY waves 2/3 + PIN-SYNC-CRON** | Last Pinnacle per-render reader cutover + legacy retirement; wire the daily `pinnacle-sync` cron + watchlist. | Med | Trevor-sequenced (price-display change) + operator. |
| **`refresh-conflated-editions` cron** | The daily honesty-guard refresh still pending operator wiring (covers conflation + thin-FMV guards). | Low | Operator. |
| **A1-WORKER-PASSTHROUGH-CLEANUP** | Carried — the special-serial owner-lookup unblock attempt was recorded ineffective; remove the residual probe. | Low | CC. |
| WEEKLY-SURFACE-QA-PROSE | 2 stale prose strings + a cosmetic footer string (`pinnacle_fmv_snapshots`) in the `rpc-live-health` artifact. | Low (cosmetic) | Deferred — a 550-line reinstall for two sentences is the wrong risk trade for an unattended pass. |
| ANALYTICS-SMOKE leg-opt | 5 slow `/analytics` dashboard fns existence-checked off the smoke path but still slow for users. | Low (optional) | CC, optional. Off the critical path. |
| IPFS-CIDSET-EVENT-LEG / IPFS-GATEWAY-FALLBACK | Two deliberately-deferred IPFS catalog-freshness / image-resilience items. | Low (deferred) | CC: do not build now; explicit triggers in the ledger. |

### 2.7 Pack EV / pack-viz — actively improved this week — `Severity: Low · Effort: shipped`

Unlike prior weeks (where this read "stable, no new defects"), pack-EV was the week's main product surface: the reality-calibration program (§2.3) shipped a model-vs-reality board, observed lifecycle, calibrated EV estimate, value-still-sealed headline, and edition pack provenance. Pack-dist math/honesty, PACKVIZ-GRID, and pack-ev v21 queue-unwedge all remain shipped from prior weeks; no open pack-EV defects.

### 2.8 Chain foundation — abstraction complete; two inert chain scaffolds prebuilt — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F are complete** (Phase F shipped 2026-06-01). **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged, bulletproof by design. **Trap:** `lib/flow.ts` is the only shim with `export default` — keep `export { default }` alongside `export *`.
- **Candy / Solana chain-two prebuild landed inert (06-08).** `collections` seeded (`candy_mlb` / `panini_blockchain`, `is_active=false`), `helius-proxy` scaffolded. It writes nothing until five discovery placeholders are filled (§5g) and is gated on the **July-8 Candy data tripwire** — do **not** start chain-two code early.
- **NEW — Panini WC2026 Prizm "Plane-A" ingest scaffold landed inert (06-26, `ec82db1`).** A repo-only ingest path (`lib/chains/panini/feed.ts` + `app/api/cron/panini-{fmv-recalc,circulation-refresh}/route.ts` + reference drafts under `docs/drafts/panini/`) that writes nothing until a per-mode discovery capture (CryptoSlam API contract or the `/onepanini` request format) is filled in. This is the source of the new 10-marker TODO cluster (§5h). Also new and inert: a **Dune-backed TopShot ownership index (Pipeline A, `e75f6c3`)** — inert until provisioned.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 0 | **Wallet verification.** "Sign in with Dapper" gated on Dapper developer access (request pending). The working path is the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim owner-attested fallback. The old `cached_listings` cron matcher is dead (frozen data) but left harmless. | Medium | Medium (core shipped; Dapper path blocked externally) |
| — | Activation machinery (omni-channel alerts LIVE + new filter UI; Rewards economy; 3 new `/insights` surfaces) shipped; **verify `funnel_events` is recording and measure whether signups / alert sign-ups move off zero.** | High | Medium (shipped, unmeasured) |

### Data-intelligence correctness (a headline this week)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Pack-EV reality calibration | Pack EV over-promised vs observed outcomes. **Shipped** — reality-adjusted headline + model-vs-reality board + observed lifecycle + edition pack provenance. | was Medium | (landed) |
| Deep-history sales backfill | FMV starved on collections with thin captured sales. **Shipped + draining** — studio-platform GQL drain across AllDay/Golazos/Pinnacle/UFC + TS-Flowty promote; zero unmapped, editions flat. | Medium | Medium (in progress) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary; waves 2/3 + legacy reader retirement queued (Trevor-sequenced). | Medium | Medium |
| TS-SALES-INGEST-GAP | ASK_ONLY ≈ editions whose sales were never captured. The real fix (`topshot-sales-history-backfill` + the new deep-history program) is shipped and draining. | Medium | Medium (in progress) |

### Safety / reliability hardening (NEW)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Destructive-op guard | Bulk/cross-cutting deletes on irreplaceable tables could corrupt silently. **Shipped LIVE** (`rpc_guard_block_destructive`). | was High | (landed) |
| Per-collection FMV freshness | A single-collection FMV outage was masked by the global freshness check. **Shipped LIVE** — trust-health 9/9 → 13/13. | was Medium | (landed) |

### Cost / operational right-sizing (carried + growing)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Vercel cost family | Carried (uncapped Spend-Management + Fluid/cron/observability levers). No new invoice this run. | Medium | Small–Medium (mostly dashboard + cron config) |
| DB storage growth | Deep-history backfill wave grew the DB ~1.3 GB (5,090 → 6,391 MB). Benign per the night pass; watch the rate. | Low–Medium | Small (monitor) |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged. Intentional, low-risk. | Low | Medium |
| Candy chain-two | 17-line discovery-placeholder block (5 named `TODO_1`–`TODO_5` + route notes) in the inert Candy/Solana ingest path — unfillable until Candy secondary trading opens (gated on July-8). Intentional. | Low | Medium (gated) |
| Panini WC2026 (NEW) | 10-marker block in the inert Panini "Plane-A" ingest scaffold — unfillable until a per-mode discovery capture lands. Repo-only, writes nothing. Intentional. | Low | Medium (gated) |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. This week: the pack-EV reality board + edition pack provenance landed (a substantial pack-page upgrade). Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page). Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, present) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — the light/dark theme tokenization sweep completed (**0 `style` commits this week**, as last). The phase-1 token sweep + CI guard (`scripts/check-brand-tokens.mjs`) remain in place. Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin), tracked not gated. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,149 lines** (verified; **flat vs last week**). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,867** (**DOWN ~71** from 2,938), `sniper/page.tsx` **2,166** (flat). **The `analytics/page.tsx` figure in `CLAUDE.md` #14 (~2,128/2,208) is STALE** — the actual `/analytics` route page (`app/(analytics)/analytics/page.tsx`) is **495 lines** and is already split into ~14 subroute pages. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (analytics already split) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts` (verified present). Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01).** `ensureLive()` (6 refs in `lib/trade-escrow/fcl-submit.ts`, verified) throws unless `RPC_TRADE_ESCROW_ADDRESS` is set; `/api/trade-chain/*` return 503; `/dashboard/trade-hub` `notFound()`s via `TradeHubClient.tsx` (verified present). 8 in-code stub TODOs persist (§5b). | Medium (shelved) | Large |
| A1 | Special-serial owner lookup — the `searchMintedMoments` unblock attempt was recorded ineffective and the probe removed; the owner-display capability — and the `special-serial-sweep` ownership lookups (§5c) — remain blocked at the TS API edge. `A1-WORKER-PASSTHROUGH-CLEANUP` is carried in the operator queue. | Low–Medium (blocked externally) | Medium (depends on TS API) |

### Net-new features not in the numbered list

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Pack-EV reality board | **Shipped (06-27/28)** — reality-adjusted EV + model-vs-reality board + observed lifecycle + edition provenance. Worth a numbered slot. | n/a (shipped) | Medium |
| Omni-channel alerts | **LIVE (06-18)** — deal/FMV alerts + Telegram/Discord bots + SoldPacks; new type-to-fill filter UI this week. 1 active subscription. Worth a numbered slot. | n/a (live, dialing in) | Medium |
| Rewards | Off-chain points economy — live, DIAL-IN. Non-code blockers: store stocking; raffle legal review. Worth a numbered slot. | n/a (live, dialing in) | Medium (non-code) |
| AllDay per-moment badges | **Shipped** — real per-moment badges via residential-Atlas ingest. | n/a (shipped) | — |
| New `/insights` | `rookie-board`, `new-collectors`, `allday-scarcity` — live, no open defects. | n/a (shipped) | — |
| Candy chain-two | Inert prebuild — see §2.8 / §5g. Gated on July-8. | n/a (gated) | Medium |
| Panini WC2026 (NEW) | Inert Plane-A scaffold — see §2.8 / §5h. Gated on discovery capture. | n/a (gated) | Medium |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives. **(Note: this week's anon-DML defense-in-depth revoke already narrowed the surface substantially — anon write grants 482 → 46.)**

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy with `qual=true`/`with_check=true` (intentionally preserved by the 06-23 revoke). Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter. (`funnel_events` follows the safer pattern — RLS-on, anon INSERT-only, no anon SELECT, event-type allowlisted + size-capped — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); migrate when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`. (Note: the new AllDay per-moment badge ingest may change this picture for AllDay — verify before building.)

### Architecture note worth tracking

- **Watchlist + FMV Alerts — partly superseded by the alerts system.** `CLAUDE.md` Architecture notes still flag the old watchlist/alert tables + routes as partially decommissioned. The omni-channel alerts feature is a *separate* implementation (`alert_subscriptions` / `notification_channels` / `lib/alerts.ts`); verify whether the old watchlist tables are now dead or should be reconciled before reactivating either.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **recommended CLOSED (keep frozen).** `docs/cleanup-decisions-2026-06-01.md` concludes nothing is safe to drop. The remaining action is to formally close the priority in `CLAUDE.md`. | §2.5 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced heavily this week** via pack-EV reality calibration, the cross-collection deep-history sales backfill, the AllDay+Pinnacle ASK_ONLY structure, real AllDay badges, the concierge model-retirement guard, and 3 new `/insights` surfaces. | §2.2 + §2.3 |

*Implicit priorities surfaced and still un-promoted:* **(a) activation/conversion + its measurement** (§2.1 — ≈13 users; machinery now includes a live alerts loop + new filter UI but is still unmeasured); **(b) cost right-sizing** (§2.6 — the carried Vercel family + the new ~1.3 GB DB growth; set the Spend-Management cap regardless). Both are arguably worth promoting to explicit `CLAUDE.md` actions.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** This is why §1 reports 0 active revenue-blocking items. (`stripe@^22` is in `package.json` but dormant.)

---

## 5. In-code TODO inventory

A gitignore-aware scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`, substring match on `TODO|FIXME|HACK|XXX` to also catch the `TODO_N`-style named placeholders) returned **69 raw matches across 41 files**. Excluding **3 false positives** (see §8) leaves **66 real marker lines across 38 files** — **+10 vs last week's 56.** All ten new markers are the inert Panini WC2026 Plane-A scaffold (§5h). `CLAUDE.md` does not track these. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest single cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.8. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files) — unchanged

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs (`submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`). Fronted by `ensureLive()` (6 refs) so the stubs throw rather than return fake tx ids when the contract is unset.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI shows `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file) — unchanged, still A1-blocked

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. **This is the data-layer counterpart of the A1 block** — the owner-display feature needs the Top Shot GQL `searchMintedMoments` capability that A1 could not unblock (§3, A1).

### 5d. Pipeline calibration / migration (3 markers, 3 files) — unchanged

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files) — unchanged

- `app/(collections)/[collection]/collection/page.tsx:2659` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. (Line shifted 2706→2659 with the collection-page edits; same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11.
- `scripts/ingest-topshot-active-listings.mjs:126` — `TODO: set the real dapper.market listing URL once its format is confirmed.`

### 5f. Cadence test coverage gap (2 markers, 1 file) — unchanged

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

### 5g. Candy / Solana chain-two discovery placeholders (17 lines, 3 files) — unchanged

The inert chain-two prebuild (06-08) wraps **5 named discovery placeholders** unfillable until Candy secondary trading opens (gated on July-8):

- `lib/chains/solana/normalize.ts` (14 lines — `:5,10,27,29,31,33,35,37,39,40,64,158,162,166`) — the `DISCOVERY TODOs` block: `TODO_1` (Metaplex Core collection mint → `CANDY_MLB_COLLECTION_ADDRESS`), `TODO_2` (Magic Eden symbol → `CANDY_MLB_ME_SYMBOL`), `TODO_3`/`TODO_4` (serial / edition-size attribute keys), `TODO_5` (stable per-edition key), plus the `.startsWith("TODO_")` route-guard checks.
- `app/api/ingest/candy-editions/route.ts` (`:8`, `:72`) + `app/api/candy-sales-indexer/route.ts` (`:111`) — inert-ingest notes that short-circuit the routes until the placeholders are filled.

→ Intentional, gated debt. The routes write nothing while the placeholders are unfilled.

### 5h. NEW — Panini WC2026 Prizm "Plane-A" discovery placeholders (10 markers, 6 files)

The inert Panini WC2026 Prizm ingest scaffold (`ec82db1`, 06-26) — repo-only, writes nothing — wraps a per-mode discovery capture not yet performed:

- **Live scaffold (5 markers, 3 files):** `lib/chains/panini/feed.ts` (lines 64, 70, 80 — `TODO(go-live discovery)` for the CryptoSlam NFT API contract + the `/onepanini` request format), `app/api/cron/panini-circulation-refresh/route.ts:107` and `app/api/cron/panini-fmv-recalc/route.ts:82` (both `TODO(go-live)` short-circuit notes).
- **Reference drafts under `docs/drafts/panini/` (5 markers, 3 files):** `ingest-panini-runner.mjs` (lines 16, 29, 33), `panini-ingest-route.ts:137`, `panini-proxy/index.js:19`.

→ Intentional, gated debt — the same shape as the Candy block (§5g). The routes are inert until `paniniFeedEnabled()` is satisfied and the per-mode discovery TODO is filled. Do **not** wire a cron / watchlist until then.

> **Net change since last week:** **+10 markers / +6 files** (the entire §5h Panini cluster). The §5a–§5g markers are otherwise content- and line-identical to the 2026-06-22 inventory (modulo the one line-shift on the §5e `collection/page.tsx` marker, 2706→2659).

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md` / `metrics-latest.json`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — DSN set), #3 (Flowty event indexer — reclassified, Flowty shut down), #4 (Pinnacle FMV — resolved + per-render-enhanced; the stale-table-name footgun was corrected in `CLAUDE.md` this week), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — `lib/warmup/WarmupContext.tsx` prefetches `/api/packs`), #7 (AllDay `unmapped_sales` — resolver rewritten; the V1-budget *drift* is the separate LOW operator item ALLDAY-V1-UNMAPPED-DRIFT), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — fully blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed this week:**
- **Pack-EV reality calibration — SHIPPED** (reality-adjusted headline + model-vs-reality board + observed lifecycle + edition provenance). Not a "resolved bug" but a major intelligence upgrade. (§2.3)
- **Cross-collection deep-history sales backfill — SHIPPED + draining** (studio-platform GQL drains; zero unmapped, editions flat). (§2.3)
- **TS-WMC-UUID-FOSSILS — CLOSED** — on-chain re-key (`f130face`) drove `ts_wmc_uuid_fossils` 1,748 → 0 (a re-key, not a delete, per Trevor's standing decision). Verified 0.
- **Destructive-op circuit-breaker — SHIPPED LIVE** (`rpc_guard_block_destructive`). (§2.4)
- **Per-collection FMV freshness — SHIPPED LIVE** (`v_rpc_trust_health` 9/9 → 13/13). (§2.4)
- **Concierge model-retirement guard — SHIPPED** (`20d75a2`).
- **Defense-in-depth anon-DML revoke — SHIPPED** (anon write grants 482 → 46; invariants stayed 0).
- **Real AllDay per-moment badges — SHIPPED** (`e56e4e3`).
- **UFC video_url 518/518 + 72 UFC null set_name + Golazos video_url — RECOVERED.**
- **Pinnacle-FMV table-name footgun in `CLAUDE.md` — FIXED** (docs-only; `pinnacle_fmv_snapshots` → `pinnacle_fmv_history`).
- Monitor/operator closures: ALLDAY-FMV-POPULATE-NOOP-STALL, PACK-EVENTS-CRONJOB-STALL, LISTCACHE-CRON-DROP, UFC-EDITIONS-SEED-GAP, UFC-VIDEO-RLS, NEW-COLLECTORS-INSIGHTS-QA, ROOKIE-BOARD-INSIGHTS-QA.

**Also shipped this week (net-new, not numbered):** the 3 `/insights` surfaces (rookie-board / new-collectors / allday-scarcity); the AllDay+Pinnacle ASK_ONLY FMV structure (`9056eff`); the alerts type-to-fill filter UI (`716566b`, `3e96f44`); the inert Dune TopShot-ownership Pipeline A (`e75f6c3`); the inert Panini WC2026 Plane-A scaffold (`ec82db1`); table-driven sentinel thresholds (`0a684d2`); the concurrency guard + GHA backstop (`611b2fb`); the spork-proxy mainnet17 extension (`59ddb6b`).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation and cost both promoted given the week's events:

1. **Measure the activation machinery you've built (§2.1) — including the live alerts loop + new filter UI.** Cheapest, highest-leverage — confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop AND alerts (sign-ups, channel links, deliveries); open alerts to the allow-list; unblock the Rewards DIAL-IN. Then watch whether signups move off zero.
2. **Let the FMV-correctness work soak (§2.3).** Watch the deep-history backfill converge; keep `v_fmv_sanity_flags` + the new per-collection `*_fmv_stale_hours` tripwires in the weekly health check; finish PIN-FMV-REKEY waves 2/3 and retire any legacy readers; confirm the pack-EV realized-EV views stay fresh.
3. **Right-size cost + storage (§2.6).** Do the Spend-Management cap backstop regardless; watch the DB-growth rate from the backfill wave (now 6.4 GB); then the Fluid/cron levers.
4. **Clear the small operator items (§2.6).** Wire (or classify) ALLDAY-V1-UNMAPPED-DRIFT; wire the `refresh-conflated-editions` daily-guard cron + PIN-SYNC-CRON; watchlist `topshot-sales-history-backfill`; do A1-WORKER-PASSTHROUGH-CLEANUP; decide the optional ANALYTICS-SMOKE leg-opt.
5. **Formally close Priority #1 (Flowty, §2.5)** — record the keep-frozen decision in `CLAUDE.md`.
6. **Chain-foundation cleanup as capacity allows (§2.8 / §5a / §5g / §5h).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` trap). The Candy block stays until July-8; the Panini block stays until a discovery capture. Deferrable.
7. **Pack/Moment/Set tail (#17 — pack EV largely done), brand Phase-2 (#11, largely done), `/dashboard` migration (#10), monolith refactor (#14 — note analytics is already split).** Lowest priority.

---

## 8. Notes from verification

- **Git was available and reliable this run.** HEAD = `c493532` (2026-06-28, "feat(packs): reality-adjusted EV headline + model-vs-reality board + edition pack provenance"). `git log --since=2026-06-22` returned **157 commits** — ~59 code-bearing (31 `feat` / 24 `fix` / 3 `perf` / **1 `refactor`**), the rest process/automation (48 `docs` / 27 `monitor` / 9 `chore` / 5 `night pass` / 4 `ops` / 3 `overnight` / 2 `daytime monitor`). (Last week had 0 `refactor`; this week has 1.)
- **Report-location is clean.** `ls PROJECT_HEALTH*` at the repo root returns nothing; `docs/health/` holds the eight prior reports + this one.
- **No active freeze.** `docs/FREEZE.md` is absent (it exists only while a freeze is active).
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,867** (DOWN from 2,938) · `sniper/page.tsx` **2,166** (unchanged) · `dashboard/page.tsx` **2,149** (unchanged) · `lib/blazers-trivia.ts` **198** (unchanged) · `app/(analytics)/analytics/page.tsx` **495** (was 503).
- **Stale figure carried (unchanged) — the analytics monolith.** `CLAUDE.md` #14 still lists `analytics/page.tsx` at ~2,128/2,208 lines. The actual `/analytics` route page (`app/(analytics)/analytics/page.tsx`) is **495 lines** and is already split into ~14 subroute pages. The genuine remaining monoliths are `collection/page.tsx` (2,867) and `sniper/page.tsx` (2,166). Recommend correcting #14 in `CLAUDE.md`.
- **TODO scan: 69 raw matches / 41 files → 66 real markers / 38 files** (after excluding 3 false positives). **+10 vs last week's 56** — the new markers are the §5h Panini WC2026 cluster (10 markers / 6 files). By cluster: 18 chain-rename shims (§5a) · 8 Trade Hub stubs (§5b) · 4 special-serial-sweep stubs (§5c) · 3 pipeline-calibration (§5d) · 4 smaller polish (§5e) · 2 Cadence-test gap (§5f) · 17 Candy/Solana placeholders (§5g) · 10 Panini placeholders (§5h) = 66.
- **Three TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"`; `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_...`; and **NEW this week** `supabase/migrations/20260624162548_recover_golazos_video_url_from_thumbnail_key.sql:6` — `XXX` inside the format note `numeric_numeric_recXXX` (a record-key shape illustration, not a marker). All three excluded from the 66. (Note: the strict `\bTODO\b` word-boundary regex returns 54/39 because it skips the `TODO_N` named placeholders; the substring scan used here matches the prior report's methodology — 69 raw / 66 real.)
- **`/insights` surfaces: 21** — confirmed by `INSIGHT_ROUTES` in `app/sitemap.ts` and the `app/insights/` dir (+`rookie-board`, `allday-scarcity`, `new-collectors` since last week's 18). **OG routes: 14 top-level + 20 per-surface `/api/og/insights/*` + 1 shared fallback** (only `tc-report` uses the fallback; the per-surface set grew 17 → 20).
- **Dependency facts:** `next` and `eslint-config-next` are pinned to **16.2.9** (unchanged from the 06-22 security bump); `stripe@^22` present but dormant (monetization tabled).
- **Cited-path spot check:** all expected-present known-issue paths verified — `lib/chains/flow/cadence/purchase-moment.ts` (#1), `app/api/profile/verify-challenge/check/route.ts` (#0), `app/dashboard/trade-hub/TradeHubClient.tsx` + `lib/trade-escrow/fcl-submit.ts` (6 `ensureLive` refs) (#3), `supabase/functions/special-serial-sweep/index.ts` (A1/§5c), `scripts/check-brand-tokens.mjs` (#11), `docs/audits/refactor-plan-monolith-pages-2026-05.md` (#14), `docs/cleanup-decisions-2026-06-01.md` (Flowty), `.github/workflows/ci.yml` (#16), `lib/warmup/WarmupContext.tsx` (#6), `lib/blazers-trivia.ts` (#12), `docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md` (#17), the alerts surface (`lib/alerts.ts`, `app/alerts/page.tsx`), and this week's new scaffolds (`lib/chains/panini/feed.ts`, `lib/chains/solana/normalize.ts`). Intentionally-deleted paths remain correctly absent (`scripts/cleanup-storefront-wallets.mjs`, root `cleanup.cdc`, `components/PinnacleSniper.tsx`, `lib/pro/gate.tsx`).
- **DB-side facts** (FMV counts, trust-health 13/13, security 0/0/0/0, editions counts, `ts_wmc_uuid_fossils` 0, anon-grant 482→46, DB size 6,391 MB, conflation/backfill numbers) are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` / `docs/overnight/metrics-latest.json` (captured 2026-06-28T08:06Z) / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports. The logged prod deploy at that snapshot was `c688f673` READY (the 06-28 daytime pack-EV commits, incl. HEAD `c493532`, landed after the night-pass snapshot). `focus.md` is dated 2026-06-24; `ledger.md` (385 KB) is the authoritative live record.
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-06-29)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev "Sign in with Dapper" blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired; 0 unresolved/24h |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty indexer resolved; Trade Hub shelved + guarded | `ensureLive()` (6 refs) + 503 routes + `TradeHubClient.tsx` |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary; stale-table-name footgun corrected in `CLAUDE.md` this week | `pinnacle_fmv_history` (live); `pinnacle_fmv_snapshots` dropped |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** (V1-budget *drift* is the separate LOW operator item) | `CLAUDE.md` + metrics-latest unmapped 26/100 |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — manual script; cleanup driver deleted; payer wallet/cron paused | `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` correctly gone |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,149** lines (flat) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — light/dark theme sweep complete (0 `style` commits); phase-1 token sweep + CI guard in place | `git log`; `scripts/check-brand-tokens.mjs` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection **2,867** (DOWN ~71) / sniper **2,166**; **the analytics figure is STALE — actual `/analytics` page is 495 lines, already split into subroutes** | `wc -l` + dir |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | `git ls-files` |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — pack EV substantially upgraded this week** | pack-EV reality board + edition provenance landed; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **pack-EV reality board**, **omni-channel alerts**, **Rewards**, and **AllDay per-moment badges** features, the 3 new `/insights` surfaces, and the gated Candy + Panini chain prebuilds.

**Bottom line for `CLAUDE.md`:** the known-issues numbering is unchanged from last week and several recurring recommendations still stand: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **give the live pack-EV reality board, omni-channel alerts + Rewards features numbered slots** (e.g. #19/#20/#21); (c) Prioritized Action #1 (Flowty) can be **closed** (keep frozen); (d) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 chain-rename shims, the 17-line Candy block, and the **new 10-line Panini block** are intentional debt worth a one-line note; **(e) correct the #14 analytics line count** — `analytics/page.tsx` is ~495 lines (already split into subroutes), not ~2,128/2,208, so the two genuine monoliths are `collection` (2,867) and `sniper` (2,166); (f) note A1 / the special-serial owner-lookup block so the `special-serial-sweep` stubs aren't mistaken for unfinished work that's actually waiting on a Top Shot API capability. And, as every recent report has said: given ≈13 users and a now-larger stack of live-but-unmeasured activation machinery, **promote activation + its measurement** to a top-line priority.
