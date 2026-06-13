# Full Platform Audit — 2026-06-12 (evening, Cowork interactive)

Run ~23:45Z 06-12 → 00:45Z 06-13, hours after DBSAT-IO-EXHAUSTION-0612 recovery (~15:30Z). Scope: DB + pipelines, security, FMV accuracy, data completeness, deploys, Sentry, GHA, alerts, Cowork estate (artifacts / scheduled tasks / skills), and a full anonymous crawl of the public site. Companion roadmap: [docs/roadmap-2026-06.md](../roadmap-2026-06.md).

Tooling note: `web_fetch` and Claude-in-Chrome were both unavailable this session; site crawl ran via a sandboxed subagent, GHA verified via DB-side evidence + the 06-12 overnight pass's GitHub API checks.

---

## 1. Verdict

**Platform is GREEN post-incident, with one structural risk (DB IO capacity) and one confirmed data regression (UFC wmc enrichment).** Everything else is polish-tier. Security is clean across all four checks. The public site renders complete, real data on every surface crawled — no broken banners, no fabricated data, no error pages.

## 2. DB + pipelines

| Check | Result |
|---|---|
| Hourly fails (16Z→00Z) | 1 / 0 / 7(wave, 0.5%) / 2 / 0 / 0 / 0 / 0 / 0 — **fully recovered since 20Z** |
| `detect_stalled_pipelines()` | `[]` |
| `get_pipeline_alerts()` | `[]` |
| `v_rpc_trust_health` | **8/8 ok** (edition integrity 4/50, fmv sanity 0, offer gap $0, pack-EV staleness 1.09d/2, pinnacle ask 0.2h/3, pinnacle FMV 14h/30, UUID dupes 0/200) |
| Sentinel TS-UUID-leak-48h | **0** |
| DB size | 4,356 MB (creep ~+45MB/day since the 06-10 drops — watch, ties into the capacity decision) |
| Key writers | fmv-recalc, allday-fmv-populate, offers-sweep, sales indexers, pack-ev, pinnacle-reconcile, listing-cache all logging ok ≤ minutes old at 00:0xZ |

**DBSAT-IO-EXHAUSTION-0612 (the third consecutive daytime IO window, worst yet — telemetry blackout + user-facing page errors) recovered ~15:30Z and has held 9h clean.** Mitigations now live: wmc write-storm closed (06-10), populate_wmc_image index fix, weekly-maintenance fix, **seed-refresh 4-cohort wave split (route `eba6491` + cron entries 7801778/80/81/82, legacy 7491038 disabled)**. Decision checkpoint already scheduled: `rpc-post-incident-recheck-jun12` (01:45Z) verifies the first paced wave; `rpc-cohort-wave-verdict-jun13` (07:30 PT) judges whether the 07:00Z+ daytime window recurs. **Clean = pacing solved it; exhausted again = the clean trigger for the Supabase compute add-on upgrade (Trevor, billing).**

## 3. Security — 0/0 clean

- RLS-off public base tables: `{}` (all tables RLS-on)
- Anon/auth write grants on RLS-off tables: none
- `check_secdef_anon_execute_violations()`: clean
- `check_public_security_invariants()`: clean
- Gated surfaces verified anon: `/analytics`, `/nba-top-shot/sniper`, `/dashboard`-class routes all 307→/login; `/api/admin/*` token-gated; no anon points path (rewards invariant holds).
- Root `/` being public is the **deliberate 2026-05-30 funnel decision** (documented in proxy.ts:122-128). CLAUDE.md's auth-chain section ("`/` is NOT public") is stale — reconcile.

## 4. FMV accuracy + data completeness

| Metric | Value | Trend |
|---|---|---|
| TS HIGH+MED | **3,259** (942 H / 2,317 M) | ↑ from 2,852 (06-10), 3,103 (06-11) — tshb backfill + audit waves compounding |
| TS NO_DATA | 4,316 | ↓ (5,029 on 06-09) |
| TS ASK_ONLY | 966 | tshb drain converting these to honest sales-backed prices (763 pending at last count; GHA full-meal config live) |
| AllDay HIGH+MED | 651 | ↑ from 481 (06-11) |
| Pinnacle per-render priced | **1,830 / 2,121 (86%)** | per-render engine healthy; freshness 14h / 30h breach |
| badge_editions TS low_ask | 8,938 / 8,938 (100% of badge rows) | catalog-walk GHA ticking (3 runs/24h clean) |
| fmv_sanity_flags | 0 | — |
| offer_sanity_flags | **176** (baseline 132, 166 @21:15Z) | ⚠ creeping — OFFER-SANITY-RAISE decision still with Trevor |
| unmapped_sales open | ~215 AllDay + 1 Golazos | ⚠ mild drift up from 183 — resolver class, watch |
| Sales 24h | TS 2,018 / AllDay 82 / Golazos 1 | TS buyer resolution 100% since b7211fb |

**One confirmed data regression: UFC-WMC-NULLKEY — 3,837/4,584 (84%) UFC wmc rows have NULL edition_key** (no FMV/set/player join on UFC dashboards). `b28a22f` (maxDuration bump) did NOT work; forensics (22:05Z inbox) show these are old never-enriched rows across 79 wallets, and the enricher logs nothing to pipeline_runs (blind spot). The agreed fix is a decoupled `ufc-enrichment-drain` cron — spec ready in [docs/handoff-ufc-enrichment-decoupled-cron.md](../handoff-ufc-enrichment-decoupled-cron.md), needs CC. Bounded to one (beta) collection.

## 5. Deploys, Sentry, GHA, alerts

- **Vercel: prod READY** on `62735e5`; latest 5 deploys READY. The 4 ERRORs (14:11–15:13Z) were incident-coupled build-infra, closed by the 21:15Z monitor after 2 canary READYs. Main is deployable.
- **Sentry: 10 unresolved, ZERO new in 9h.** All are incident-window smoke echoes (8× `POST /api/smoke-test` asserts that couldn't complete under IO starvation, 1 pinnacle listing-resolution, NEXTJS-15). Standard resolve-after-24h-quiet; none indicate live faults — the underlying checks (security, stalls, FMV sanity) all measure clean now.
- **GHA**: tshb schedule verified green (8 schedule successes since 06-11, GitHub API, TSHB-GHA-NOSCHED CLOSED); badge-sync catalog walk firing (pipeline_runs 3/24h ok); CI green on recent pushes (deploys READY).
- **Alert plumbing**: `check-alerts` 56 runs/24h (2 fails = incident window only); trust-health view feeding it 8/8; Telegram sentinel path exercised during the incident (pages fired as designed). analytics-smoke 12 runs/6h 0 fails post-recovery.

## 6. Cowork estate

- **Artifacts: 17 enumerated — 12 active + 5 intentional "(RETIRED)" tombstones** (audit-followups, pipeline-reliability, security-drift, fmv-watch, insights-health — never repair these back to live). All active artifacts validated end-to-end at the 21:15Z monitor tick including the heavy rpc-live-health consolidated payload. Single-payload query pattern is the convention — preserve it on any repair.
- **Scheduled tasks: 13 enabled, all sane.** Recurring: nightly pass, daytime monitor (absorbed trust-health + cross-collection verify), weekly health check + report, Tue data-quality, Thu surface-QA, Wed Flow-ecosystem watch, bi-weekly dependency digest, monthly strategy + memory consolidation, daily signups watch, daily Candy launch watch. One-offs queued: post-incident recheck (01:45Z), cohort-wave verdict (Sat 07:30), Candy interim 6/22 + tripwire 7/8, PAT-expiry reminder 8/31. Disabled tasks are all deliberate folds/one-shots.
- **Skills**: rpc-data / rpc-migration / rpc-handoff / rpc-cron-ops / rpc-insights-qa installed and current. No gaps found.

## 7. Site crawl (anonymous, ~30 surfaces)

All green at the rendering level: marketing home with live data + JSON-LD, /insights hub + squeeze/market/pack-sniper/cross-collection boards all fresh-stamped with real rows (52 pack deals, 158-wallet cohort, RPC Index live), all 5 collection overviews 200, edition/set/player/team/pack-dist pages render with data + Product/Breadcrumb JSON-LD, /share/0xbd94… fully SSR ($86,682 FMV, 18,683 moments), blog (2 posts), pricing (free-beta framing), legal/fmv-methodology, robots + 28,142-URL sitemap. Auth gates correct everywhere tested. **No offline banners, no error text, no fabricated data.**

Findings worth fixing (ranked):

1. **`/api/fmv/demo` is login-gated (307)** — regression vs its documented public/no-auth contract (CLAUDE.md "RPC FMV API"). One-line `isPublicPath` carve-out in proxy.ts. Anything linking the demo hits a login wall.
2. **Anon collection-overview panels call gated APIs** — `/api/sniper-feed`, `/api/packs`, `/api/marketplace-status` 307 for anon, so "Top Sniper Deals" / pack modules / pipeline status silently render empty on the SEO'd `/<collection>/overview` pages — the funnel's first impression. Open read-only variants or hide the panels for anon.
3. **`/profile/<username>` is SSR-empty** ("PORTFOLIO FMV —", "0 moments") — the founder's profile, linked as the "build your own" growth surface, looks broken in link previews / pre-hydration. `/share` proves the SSR pattern works; mirror it.
4. **Cart chrome still in global nav** ("Your cart is empty — add moments from the Sniper") on every public page — Cart is shelved (known-issue #1); dead-feature UI on an intelligence product. Hide it.
5. **Duplicate WebApplication JSON-LD** on the home page (two near-identical blocks). Consolidate.
6. Minor: entity pages' visible SSR body is only the "SCANNING THE MARKETPLACE…" fallback (titles/JSON-LD are SSR, data is in the RSC payload — fine for Googlebot, empty for no-JS readers). Low priority.
7. `/ufc-strike/*` 308s to `/ufc/*` (canonical) — works, just note the slug when sharing links.

## 8. Open items consolidated (who / what)

| Item | Owner | State |
|---|---|---|
| Compute add-on decision (DBSAT class) | **Trevor** | Gated on Sat 07:30 cohort-wave verdict |
| UFC enrichment drain | **CC** | Spec ready (handoff-ufc-enrichment-decoupled-cron.md) |
| fmv/demo public + anon-overview panels + profile SSR + cart chrome + JSON-LD dupe | **CC** | New this audit (§7) — small batch |
| OFFER-SANITY-RAISE (176 flags, creeping) | **Trevor** | Product call; raise must be edition-level, monitor lands with it |
| topshot-listing-cache cadence ~6x thin | **Operator** | cron-job.org entry inspection |
| TFP watchlist 800→480 restore | Night pass | Gate: 2nd clean tick (01:15Z) — verify, don't re-apply if done |
| ANALYTICS-SMOKE-RESIDUAL (restore 60s cap) | CC | Carried |
| Sentry resolve-after-quiet (10 issues) | Operator/monitor | ~24h quiet mark |
| unmapped_sales AllDay drift (183→215) | Watch | Resolver class |
| CLAUDE.md staleness (root `/` public; fmv/demo contract) | Any session | Doc reconcile |
| Legacy seed-refresh cron 7491038 delete | Operator | After one clean cohort day |
| Candy chain-two gates | Scheduled | 6/22 interim, 7/8 tripwire |
