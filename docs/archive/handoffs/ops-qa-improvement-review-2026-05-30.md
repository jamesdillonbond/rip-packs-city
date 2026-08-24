# Rip Packs City — Ops & QA Improvement Review

**Date:** 2026-05-30 · **Author:** Cowork audit pass · **Scope:** inventory of every automation/tool/process + gap analysis for new skills, artifacts, scheduled tasks, and CI/QA additions. READ-ONLY review — nothing shipped.

---

## 1. Full inventory (what's running today)

| Layer | Count | Items |
|---|---|---|
| **Cowork artifacts** | 7 | rpc-live-health, rpc-fmv-watch, rpc-my-wallet, rpc-cross-collection, rpc-trophy-ladder, rpc-deploys-and-cost, **rpc-traction** (new 2026-05-30) |
| **Scheduled Cowork tasks** | 7 | rpc-daytime-monitor (~3h), rpc-nightly-autonomous-pass (1am), rpc-weekly-health-check (Mon), rpc-weekly-health-report (Mon), candy-audit-interim (Jun 22), candy-audit-firm-tripwire (Jul 8), chain-abstraction-phase-d-f-closeout (Jun 1) |
| **GitHub Actions** | 11 | ci, smoke-tests, rpc-pipeline, allday-ingest, ts-listing-ingest, alert-checker, ops-monitor, pipeline-sentinel, pinnacle-owner-discovery, badge-sync, allow-list-reconcile |
| **cron-job.org entries** | ~49 | ~35 Vercel route crons + ~14 Supabase edge-fn crons (see docs/operations/cron-schedule.md) |
| **Supabase edge functions** | 40 ACTIVE | incl. 2 dormant Flowty (flowty-proxy, flowty-loan-indexer) |
| **Cloudflare workers** | 8 | topshot/allday/pinnacle/spork/rpc-sports/odds/reddit/hybrid-custody proxies |
| **Active DB pipelines** | ~60 | tracked in pipeline_runs |
| **Plugins installed** | 9 suites | brand-voice, customer-support, data, design, engineering, marketing, product-management, productivity, cowork-plugin-management |
| **MCP connectors live** | 4 | Supabase, Vercel, Sentry, Claude-in-Chrome (many plugin connectors available but unauthed) |

## 2. Health read (2026-05-30 ~22:40 UTC)

- **Deploys:** ~20 production deploys today (insights launch + Phase D). 1 ERROR (`dpl_9BVVoDC…`, commit `01b3878`) — self-healed by `1b7cfde` within minutes. Latest HEAD `50be23e` READY.
- **Pipelines (48h):** ~60 active, all broadly green. Highest fail *rates*: evm-transfers-ingest 5/44 (~11%), compute-topshot-pack-ev 10/183 (~5%), topshot-fmv-populate 1/3 (tiny n). All transient connection-pool / time-budget timeouts with recovery — no logic breakage.
- **Sentry:** 3 unresolved, all LOW (pinnacle-listings noise [fixed `bd4d8c4`], smoke "sales pipeline healthy" flake, pinnacle/moment destructure [fixed]).
- **Security advisors:** 3 ERROR (the 3 `topshot_pack_reality_*` SECDEF views, down from 14 — Q1 queued), 63 WARN, 24 INFO. **0 tables with RLS off.** 0 anon-write-on-RLS-off holes.
- **FMV (latest-per-edition):** TS HIGH+MED 780, NO_DATA 6,091 (improved from ~10.7k). AllDay HIGH+MED 241. DB 5.8 GB.

## 3. Where coverage is already strong — do NOT rebuild

The autonomous ops loop is genuinely complete and these recommendations deliberately avoid it:

- **rpc-daytime-monitor → inbox → rpc-nightly-autonomous-pass → ledger** already covers health sensing, candidate harvesting, collision-/CI-/subagent-gated shipping, regression watch + auto-revert, and dated handoffs.
- **rpc-weekly-health-check** already covers pipelines, silent-degradation (0-rows-written), pack EV freshness, DB size/bloat, **security/RLS drift via catalog SQL**, **traction (concierge/email/outbound/portfolio)**, and a review of autonomous changes to confirm/roll back.
- **rpc-weekly-health-report** regenerates `PROJECT_HEALTH_<date>.md` from CLAUDE.md known-issues + in-code TODO scan. (Distinct from the health-check — not a duplicate.)
- **Funnel/traction** is covered weekly (health-check §8) and on-open (rpc-traction artifact).

## 4. Gaps & recommendations (prioritized)

### Tier 1 — highest leverage

**1. Skill: `rpc-migration` (DB migration checklist).**
*What:* a slash-skill that wraps the hard-won migration rules into an executable pre-flight checklist. *Why:* migrations are the single most frequent risky action (dozens of `audit_*` in two weeks) and the source of the most-repeated bug class — `CREATE OR REPLACE` grant resets, SECDEF-view regressions, partitioned-index CONCURRENTLY-inside-apply_migration, delete-then-insert FMV, verify-rowcount-before-destructive, the two collection-string vocabularies, collection UUIDs. These live scattered across CLAUDE.md + ~15 memory entries; a skill makes both manual and autonomous migrations follow them every time. *Effort:* M (skill-creator + distill existing memory).

**2. Skill: `rpc-handoff` (Claude Code handoff packager).**
*What:* standardizes the handoff doc you write constantly (`docs/handoff-*`). *Why:* enforces the format that already matters — plain text no code fences (iPhone copy-paste), verified caller/row counts, explicit revert path per item, the Cowork deploy-split rule (DB+edge ship live; route/.tsx → handoff), and the "let Claude Code correct false premises" note. Turns your most frequent deliverable into one consistent command. *Effort:* S–M.

**3. Bootstrap a `rpc-data` context skill (via `data:data-context-extractor`).**
*What:* run the data plugin's extractor to generate a company-specific data skill encoding RPC's warehouse: collection UUIDs, the long/short vocab footgun, fmv_snapshots partitioning + UPPERCASE enum, wmc.edition_key contract, PostgREST 1000-row cap, `DISTINCT ON … computed_at DESC` patterns. *Why:* you have the `data` plugin installed but its analyze/write-query skills don't yet know RPC's schema, so they're underpowered. This unlocks correct ad-hoc analytics. *Effort:* M (interactive bootstrap).

**4. Artifact: `rpc-security-drift` board.**
*What:* on-open catalog-SQL dashboard — RLS-off tables, SECDEF-view count vs the "0 ERROR" baseline, anon-write-on-RLS-off, anon-EXECUTE on the 9 destructive fns, unused-index count. *Why:* `get_advisors` overflows the MCP context limit (known), and SECDEF-view posture has now regressed twice (14→3 this week). This is the one security signal with no glanceable surface. *Effort:* S (queries already written in the weekly-check skill).

### Tier 2 — solid value

**5. Artifact: `rpc-pipeline-reliability` (7–14d trend).**
*What:* per-pipeline fail-rate over 14d + a connection-pool/time-budget incident timeline. *Why:* rpc-live-health is 24h-only, so the recurring connection-pool theme (documented repeatedly, flagged again today as P5) gets re-discovered each sweep instead of trended. Surfaces whether saturation is worsening as you stagger crons. *Effort:* S.

**6. Skill: `rpc-insights-qa` (public-surface launch checklist).**
*What:* per-`/insights` surface ship checklist — smoke all routes+pages+OG cards, confirm RLS + anon-SELECT-only on the backing view, `security_invoker` on the view, sitemap entry, canonical layout. *Why:* you ship insights surfaces weekly; commit `91186b5` literally "smoke-confirmed all 21 surfaces" by hand, and the SECDEF-view regression came in through exactly this path. *Effort:* M.

**7. Artifact: `rpc-insights-uptime` (public product watch).**
*What:* pings the 9 public `/insights/*` routes + OG cards on open, shows row counts + last-good. *Why:* `/insights` is the entire distribution thesis and the public front door, but nothing watches it continuously between pushes (smoke-tests only fire on push + daily noon). *Effort:* S–M. (Overlaps smoke-tests on push; this is the always-on view.)

### Tier 3 — housekeeping & CI (mostly deliver as a Claude Code handoff)

**8. CI hardening (handoff):** make `cadence-lint` blocking once it's confirmed green (the `continue-on-error` is explicitly temporary in ci.yml); add `RLS-off = 0` and `SECDEF-view-count <= baseline` assertions to `/api/smoke-test`, extending the SECDEF-function guard you shipped today (`f9388c7`).

**9. Cron cleanups (from docs/operations/cron-schedule.md):** dial `FMV Recalc Force Stale` back from the temporary every-10-min to `8,28,48` now the first sweep is done; delete the duplicate `wmc-fmv-populate` *edge-function* cron (the Vercel route version is canonical); wire the two pending additions (FMV cold-tail drain, Pinnacle listings reconcile).

**10. Monthly `consolidate-memory` scheduled task.** *Why:* the memory index is ~40 entries and several are explicitly "CORRECTED" — a monthly reflective pass (skill already installed) merges duplicates, prunes stale facts, and keeps working memory tight. *Effort:* S.

**11. Optional — daily funnel pulse (launch-window only).** A short daily Slack/email-style digest of outbound_clicks-by-surface + email captures + concierge convos + signups, *only while actively pushing for the first 50 WAU*. The weekly check + rpc-traction artifact already cover this at rest, so this is a temporary cadence bump, not a permanent add. Note: outbound-click instrumentation only went live today (`3x8yfn7`), so daily signal starts now.

**Also noted (no action required):** flowty-proxy + flowty-loan-indexer edge functions are still ACTIVE but dormant post-teardown — sleeping idle code, zero cost; optional cleanup only.

## 5. Suggested sequence

1. `rpc-migration` skill + `rpc-security-drift` artifact (most-repeated risk + the one blind security signal).
2. `rpc-handoff` skill + bootstrap `rpc-data` (cut friction on your two most frequent deliverables).
3. Pipeline-reliability + insights-uptime artifacts; insights-QA skill.
4. CI/smoke hardening + cron cleanups via one handoff; schedule monthly memory consolidation.
