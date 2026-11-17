# Rip Packs City — Full Platform Audit & Health Check (2026-06-18)

On-demand comprehensive audit (Cowork, ~14:30Z / 07:30 PDT). Read-only. Covers security, DB integrity, pipelines/crons/GHA/edge functions, FMV accuracy, cross-parallel pollution, errors (Sentry/Vercel), artifacts, scheduled tasks, Telegram alerting, and a live UI/UX/CX walk. Companion: [docs/roadmap-2026-06.md](../roadmap-2026-06.md) (updated same session).

## Verdict

**GREEN across the board.** No security holes, no data corruption, no cross-parallel/cross-collection pollution, no error fires. The platform is the cleanest it has been — 5th+ consecutive clean night, trust-health 9/9, 0.14% pipeline fail rate, FMV reconciling exactly to edition counts. One genuine operational watch item (`topshot-buyer-backfill` duration-creep) and a short list of cosmetic/housekeeping nits. The specific concern Trevor raised — parallel tracking and cross-parallel pollution — is **verified clean** at the data layer and on the live site.

---

## 1. Security — 0 / 0 / 0 / 0

| Check | Result |
|---|---|
| `check_public_security_invariants()` | **null** (no RLS-off / anon-write base tables) |
| `check_secdef_anon_execute_violations()` | **[]** (no SECDEF fn exposes anon EXECUTE) |
| RLS coverage | on all public tables (posture held) |
| SECDEF anon-revoke | intact |

The curated invariant RPCs are the canonical signal (raw `get_advisors` overflows context and is dominated by known lint-level items — search_path / unused-index). Both curated checks clean. Onboarding/redeem sybil gates intact (no user-writable points path; 0 stuck redemptions).

## 2. Database integrity — clean

| Metric | Value | Notes |
|---|---|---|
| DB size | 4,807 MB | +69 MB/24h benign creep |
| trust-health legs | **9 / 9 ok** | fmv_sanity 0, edition_integrity 4 (<50), pack_ev stale 0.79d, pinnacle_ask 0.1h, pinnacle_fmv 4.4h, unmapped backlog 9 (<100) |
| `ts_uuid_dupes_created_24h` | **0** | DQ4 dupe-writer leak stays closed |
| editions | TS 15,543 · AllDay 6,191 · Golazos 581 · UFC 446 · Pinnacle 487 | all flat |
| sales (24h) | 3,423 | |
| pipeline_runs (24h) | 9,027 runs / **13 fails (0.14%)** | |

## 3. Pipelines / crons / GHA / edge functions

- **`detect_stalled_pipelines()` / `get_pipeline_alerts()`:** one real flag — `topshot-buyer-backfill` silent ~3.6h (90m threshold). Plus one `info` (golazos_sales resolving 1 edition in 24h). Otherwise clean.
- **13 fails / 24h, all known/transient:** evm-transfers-ingest ×7 (Base RPC 429 throttle — off-to-the-side EVM/Beezie indexer, not user-facing), alerts-dispatch ×3 (deal-leg 30s statement timeout — see §9), check-alerts ×1 + offers-sweep ×1 + wmc-fmv-populate ×1 (transient DB-IO/GQL).
- **pg_cron (in-DB):** 4 active — `rpc-ccm-step1/step2` (cross-collection refresh, daily 04:10/04:25), `rpc-serial-fmv-multipliers-weekly` + `rpc-serial-fmv-power-model-weekly` (both Sun 11:00). All `active=true`.
- **Edge functions:** 40 ACTIVE. Live ones healthy (compute-topshot-pack-ev v38, allday-unmapped-resolver v15, pinnacle-nft-resolver, ipfs-catalog-loader v4, enrich-ufc-wallet v28). Dead-Flowty functions (flowty-proxy, flowty-loan-indexer) + retired storefront functions remain as dormant idle code — optional teardown cleanup, zero cost.
- **GHA / cron-job.org:** health confirmed via telemetry (9,027 runs/24h, pg_cron all active, detect_stalled essentially clean). Known item: badge-catalog cron-job.org duplicate-trigger (documented 06-18, no code change).

## 4. FMV accuracy — healthy, reconciles exactly to edition counts

Latest-per-edition confidence (`sentinel_fmv_confidence_rows`). Each collection's totals sum **exactly** to its edition count → no orphans, no double-counting.

| Collection | HIGH | MED | LOW | ASK_ONLY | SALES_ONLY | STALE | NO_DATA | HIGH+MED |
|---|---|---|---|---|---|---|---|---|
| Top Shot | 854 | 2,282 | 5,637 | 2,616 | 20 | 589 | 3,545 | **3,136 (20%)** |
| All Day | 231 | 591 | 2,985 | 12 | — | 4 | 2,368 | 822 (13%) |
| Golazos | 1 | — | 19 | 84 | — | 2 | 475 | thin (expected) |
| UFC | — | 1 | 20 | 3 | — | — | 422 | thin (expected) |

- `fmv_sanity_flags = 0` (no impossible FMV). TS NO_DATA tail (3,545) is the structural zero-lifetime-sales / troll-ask set — coverage is complete, the lever is *quality* not coverage (per prior decisions).
- **Serial-FMV layer** populated and current: power-law model `serial_fmv_power_model` (5 segments) is primary; flat `serial_fmv_multipliers` (37 cells) is the fallback; both refresh weekly via pg_cron (jobs 5+6, active). 269 active TS listings feed the deal board.

## 5. Cross-parallel / cross-collection pollution — VERIFIED CLEAN

This was Trevor's headline concern. Every high-stakes join is collection-scoped; spot-checked live on-site.

| Probe | Result |
|---|---|
| `fmv_snapshots` collection ≠ edition collection | **0** |
| `sales` collection_id ≠ edition collection_id | **0** |
| `sales` collection text ≠ edition collection text | **0** |
| `pack_drop_pool` collection ≠ edition collection | **0** |
| FMV orphan snapshots (30d) | **0** |
| `external_id` collisions across collections | 583 — **benign** (see below) |
| wmc edition_key matching only another collection | 4 — **false positives** (Pinnacle; its editions live in `pinnacle_editions`, not `editions`) |

- The **583 collisions** are 581 Golazos×AllDay + 2 TS×AllDay — numerically-coincident integer-pair `external_id`s in different collections. They cause **zero** actual mis-mapping because sales/FMV/pack/wmc all join with `collection_id` scoping (proven by the 0-mismatch rows above). Not pollution; expected.
- **Live parallel proof (play 127, Zion Williamson — 6 parallels):** each parallel carries an independent FMV — Cosmic $872, Holo MMXX $720, Rookie Debut $154 (HIGH, 3 sales/30d), Metallic Gold $85, Base Set $55, Denied! $52. On the live edition page (`/nba-top-shot/edition/8:127`): PARALLELS section lists the 5 siblings as separate cross-linked editions; RECENT SALES are all serials ≤49 (this edition's mint) — **zero** bleed from Base Set's 1,357-mint sales. FMV is keyed per-edition (setID:playID), never pooled by play.
- **Pinnacle variants** correctly separated on `/disney-pinnacle/overview` (Perry the Platypus = 3 distinct editions: Golden / Silver Sparkle / Standard, each priced independently). Per-render FMV re-key is doing its job.

## 6. Errors — Sentry / Vercel GREEN

- **Sentry:** 2 unresolved, both `POST /api/smoke-test` transients (analytics_pipeline_health, detect_stalled), both **>24h quiet** and resolvable; **0 new in 48h**, 0 actively firing.
- **Vercel:** current prod `ac50ae1` READY; last 20 deploys = **0 ERROR** (12 READY, 8 benign auto-superseded CANCELED).

## 7. Artifacts & scheduled tasks

- **14 active Cowork artifacts**, all updated 06-15/06-16, single-payload pattern intact; daytime monitor validated 14/14 OK today. The 5 RETIRED tombstones are intentional. No broken artifacts.
- **Scheduled tasks:** all recurring automation enabled + healthy (nightly pass, daytime monitor, weekly health-check/report, data-quality sweep, surface-QA, dependency digest, monthly strategy/memory, signups watch, flow-ecosystem watch, candy launch watch). Candy interim audit 6/22 + firm tripwire 7/8 scheduled; PAT-expiry reminder 8/31 set.
- **Housekeeping:** ~12 disabled one-off tasks already fired (jun8 verifies, post-incident rechecks, buyer-drain checks, floor-serial verify) — harmless clutter, optional cleanup.

## 8. Telegram / alerting

- Ops alerting wired: `pipeline-failure-alerts` edge fn ACTIVE; `@rpc_sentinel_bot`. No alert flood (fails minimal/known).
- Omni-channel user alerts (`alerts-dispatch` / `alerts-send`) correctly **inert**: 0 subscriptions, 3 notification_channels (Trevor's own email/Telegram/Discord linked). Dial-in state, as designed.

## 9. Website UI/UX/CX walk (authenticated as Trevor)

| Page | State |
|---|---|
| `/dashboard` | Complete. Portfolio $90,136 / 18,700 moments / 5 collections. Trophy case shows **live** FMV (Lillard Cosmic $425 live vs $800 acquired — trophy-slab live-FMV fix confirmed). |
| `/nba-top-shot/edition/8:127` | Excellent. FMV $872, parallels cross-linked, recent sales correctly scoped, special serials (#1 + Perfect #49 only), IPFS media verified, FMV history. |
| `/alerts` | Fully live. Parallel/variant filter populated (Galactic, Diced + 14 Pinnacle variants), tier/serial/jersey/badge filters, 3 channels linked. |
| `/disney-pinnacle/overview` | Complete + variant-aware. 487 editions, fresh ASK, clean recent sales. |
| `/insights/underpriced-serials` | Rich (19 live deals, honest tight-vs-coarse estimate labels, Buy→Dapper links, WNBA included). |

**Findings:**
- **(P3, cosmetic)** Mojibake in some Pinnacle franchise/set separators — "Disney **â¢** Phineas and Ferb" (a mis-encoded `•`). Source string has a Latin-1 bullet byte; renders fine elsewhere. UTF-8 hygiene fix on the affected `pinnacle_catalog`/`pinnacle_editions` rows or the display join.
- **(P2, freshness/honesty)** `/insights/underpriced-serials` shows "Updated Jun 17 10:49 PM" (~9h stale at audit time) while the copy promises "live, buyable" deals. Consistent with the Atlas residential-runner not firing overnight (Atlas WAFs datacenter IPs). Either surface the ingest age more prominently when stale, or confirm/repair the runner's overnight schedule.

---

## Issues & recommendations (prioritized)

1. **`topshot-buyer-backfill` duration-creep (operator/CC) — the one yellow flag.** Runs are hitting **577s against the 600s `maxDuration` cap** (23s headroom) with degraded ~2.5h cadence. If a run ever exceeds 600s it dies silently at the lambda ceiling (the invisible-failure class) and recent-sales buyer resolution stalls. Backlog is 208,719 null-buyer TS sales, but **only ~3,000 are <30 days old** (rest is a historical tail to 2020); recent 7d sales are **83% buyer-resolved and climbing**, so the pipeline works — protect it. **Lever:** lower batch 200→150 so each run finishes well under the cap. Historical-tail drain is low priority.
2. **`alerts-dispatch` deal-leg timeout (CC).** Deal-leg hits the 30s statement timeout ×3/24h. Cost is the 2-source deal-set scan, not per-sub fan-out (0 subs today) — it will worsen as subscribers are added. Already flagged ALERTS-DISPATCH-DEAL-TIMEOUT; the 06-17 materialize-pools-once migration mitigated, finish the optimization before promoting alerts.
3. **Underpriced-serials board freshness (operator).** ~9h since last Atlas ingest — confirm the residential runner's overnight cadence or show staleness on the board (§9).
4. **Reclassify SERIAL-FMV-MULT-CRON (monitor false-positive).** The monitor escalates `serial_fmv_multipliers` as "52h stale (escalating)," but the grid refreshes **weekly** via pg_cron job5 (active) — staleness up to 7d is by-design. Close it / adjust the monitor's freshness expectation.
5. **(P3) Pinnacle mojibake** (§9) — UTF-8 hygiene.
6. **Housekeeping:** prune ~12 fired one-off scheduled tasks; optionally retire dead-Flowty edge functions; refresh the stale `docs/overnight/focus.md` (still dated 06-09).
7. **Roadmap-level:** deal alerts cover **TS + Pinnacle only** (the deal-board backing) — extend to AllDay/Golazos/UFC once those collections have a listings/deal feed.

## Bottom line

Security, integrity, FMV accuracy, and **parallel tracking are all clean and accurate**. The site shows full, complete, correct data with proper per-edition/per-variant isolation. Fix the buyer-backfill ceiling before it bites; everything else is polish.
