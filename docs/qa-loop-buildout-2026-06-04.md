# RPC platform QA-loop buildout — scheduled activities, skills, artifacts, runbooks

Proposal (2026-06-04) for a full QA funnel: a layered set of scheduled activities that continuously sense → triage → fix → verify → report across every platform surface, so drift (stale artifacts, data mispricing, funnel leaks, SEO regressions, security creep) is caught by the loop instead of by a manual pass.

Design principle for a solo, pre-traction founder: **few tasks, each broad and cheap, no overlap.** Every item below maps to a real gap observed this session, and risky fixes still route to a human/Claude-Code handoff — the loop senses and triages everything but only auto-ships the genuinely-low-risk slice.

---

## 1. The funnel (5 cadence layers × the same 5-stage loop)

Every layer runs the same loop — **SENSE → TRIAGE → FIX → VERIFY → REPORT** — at a different depth/cadence, and they all feed one shared ledger (`docs/overnight/ledger.md`) + one glance surface (a QA scorecard artifact).

| Layer | Cadence | Role | Today | 
|---|---|---|---|
| **L1 Continuous** | every ~3h (8am–11pm) | sense health, harvest candidates | `rpc-daytime-monitor` ✅ |
| **L2 Daily** | 1am | drain inbox, auto-ship ≤4 low-risk, regression-watch | `rpc-nightly-autonomous-pass` ✅ |
| **L3 Weekly deep-QA** | Mon + 2–3 themed days | reconcile data, audit surfaces, sweep deps | partial (`rpc-weekly-health-check` + `-report`) ⚠️ |
| **L4 Monthly strategic** | 1st | memory hygiene, competitive/strategic review | `rpc-monthly-memory-consolidation` ✅ (+ gap) |
| **L5 On-demand** | interactive | deep audits like today | manual ✅ |

L1/L2/L4 are solid. **The gap is L3** — there's no systematic weekly coverage of data-quality reconciliation, user-facing surfaces (artifacts/brand/CX/mobile), SEO/indexing, or dependency/bloat hygiene. Everything found "by hand" this session (stale artifact prose, GQL-vs-chain offer gaps, the funnel/Cart dead-ends, the sitemap-empty SEO blocker, unused indexes) lives in that gap.

---

## 2. What exists today (mapped to the loop)

- **Scheduled (7):** daytime-monitor (L1), nightly-autonomous-pass (L2), weekly-health-check + weekly-health-report (L3), monthly-memory-consolidation (L4), candy-audit-interim-june22 + candy-audit-firm-tripwire-july8 (one-time chain-two tripwires).
- **Artifacts (12, live re-query):** rpc-live-health, rpc-fmv-watch, rpc-pipeline-reliability, rpc-security-drift, rpc-insights-health, rpc-traction, rpc-deploys-and-cost, rpc-my-wallet, rpc-cross-collection, rpc-trophy-ladder, rpc-audit-followups, rtr-pack-finder. (All audited 2026-06-04: accurate + on-brand.)
- **Skills (4):** rpc-data, rpc-migration, rpc-handoff, rpc-insights-qa.
- **Reconciliation views shipped:** `v_fmv_sanity_flags` (wired into weekly-check), `v_offer_sanity_flags` (NEW — not yet wired).
- **Markdown spine:** CLAUDE.md, ledger.md, docs/handoff-*, docs/operations/cron-schedule.md, docs/health/, docs/audits/.

---

## 3. Gaps the loop doesn't cover yet

1. **Data-quality reconciliation** — `v_offer_sanity_flags` unwired; no scheduled integrity sweep (orphans, FK drift, dupes, unmapped_sales backlog, sentinel leaks beyond the live one).
2. **Artifact freshness** — drift is only caught by a manual audit (this session). No recurring check.
3. **User-facing surface QA** — no scheduled live-page check for brand-token drift, funnel/CTA leaks, mobile overflow, or fabricated-data regressions (all found manually before).
4. **SEO / indexing** — the 33K-URL sitemap, canonical, JSON-LD, robots are unmonitored; the "sitemap advertised 0 entity URLs" blocker was caught by hand.
5. **Dependency / advisory / bloat** — dependabot is security-only; no scheduled Supabase advisor digest, npm-audit summary, or unused-index/bloat sweep (today's index drop was manual).
6. **Offers pipeline (new)** — needs QA coverage as it accrues (reconciliation, depth, fill, cron liveness).
7. **Strategic cadence** — monthly memory exists, but no recurring competitive/traction/roadmap review (the 50-WAU gate, distribution).

---

## 4. Proposed additions

### A. Scheduled events — 3 new weekly themed sweeps + 2 extensions (completes L3)

1. **`rpc-data-quality-sweep`** (weekly, e.g. Tue) — the *is-the-data-correct* layer. Runs `v_fmv_sanity_flags` + `v_offer_sanity_flags`, orphan/FK/dupe checks, `unmapped_sales` backlog, sentinel UUID-leak, FMV freshness/coverage, pack-EV staleness. Auto-ships only additive monitoring config; flags real mispricing/integrity to the ledger. *Powered by a new `rpc-data-quality` skill.*
2. **`rpc-surface-qa`** (weekly, e.g. Thu) — the *does-the-product-look-right* layer. Audits all artifacts for staleness + brand (what I did by hand today); Chrome spot-checks the home funnel + a moment/edition/insights page at desktop **and** 390px mobile; greps live routes for fabricated-data + hardcoded brand literals; samples sitemap/canonical/JSON-LD. *Powered by new `rpc-artifact-qa` + `rpc-surface-qa` skills.*
3. **`rpc-dependency-advisory-digest`** (bi-weekly) — the *is-the-platform-clean* layer. Supabase advisors via catalog SQL (get_advisors overflows), npm-audit / dependabot summary, unused-index + bloat sweep, dead-object detection. Recommends drops; ships only the strictly-safe ones (duplicate/dead-table indexes).
4. **EXTEND `rpc-daytime-monitor`** — add the 2 offer indexers + the sanity views to its 3h sweep (so an offer-cron stall or a new mispricing surfaces continuously, not just weekly).
5. **EXTEND `rpc-monthly-memory-consolidation` → add a strategic half** — a monthly traction/competitive/roadmap review (WAU trend, funnel metrics, competitor moves, what to build next), feeding the roadmap.

Net schedule after buildout: 3h monitor · 1am nightly · **Tue data-quality · Thu surface-QA · Mon health-check + report** · bi-weekly deps · 1st memory+strategy. A clean weekly rhythm, no two heavy DB sweeps on the same day.

### B. Skills — 3 new (each powers a sweep), reuse 4 existing

- **`rpc-data-quality`** (new) — reconciliation + integrity checklist: the sanity views, GQL-vs-chain, orphan/dupe/FK patterns, the "verify rowcount before destructive" + two-vocab footguns. Powers the data-quality sweep.
- **`rpc-artifact-qa`** (new) — the artifact audit/refresh checklist used today: stale-object list, brand-token rules, the live-query-vs-static-prose distinction, the update_artifact round-trip. Powers surface-QA's artifact half.
- **`rpc-surface-qa`** (new) — live-page QA: funnel/CTA anon-reachability, mobile-overflow spots, fabricated-data greps, SEO sample (sitemap/canonical/JSON-LD/robots). Powers surface-QA's page half. *(Could fold into rpc-artifact-qa as one "surface" skill if you prefer 1 over 2.)*
- Reuse: `rpc-data` (warehouse context), `rpc-migration` (safe DDL), `rpc-handoff` (CC packaging), `rpc-insights-qa` (pre-ship insights checklist).

### C. Artifacts — 2 new + a freshness contract

- **`rpc-offers-intelligence`** (new — this was queued) — depth by type, fill/cancel rates, top-demand editions, whale/insider bidders, GQL-vs-chain gaps (over `offers` + `v_offer_sanity_flags`). Also the working prototype for the public `/insights/offer-depth` board.
- **`rpc-qa-scorecard`** (new) — the single-glance roll-up: one artifact that pulls the headline from each QA domain (security 0/0/0, stalled pipelines, data-quality flag count, FMV/offer sanity, artifact-freshness, deps) into one scorecard with red/amber/green. The "is everything OK?" home base.
- **Freshness contract:** the `rpc-surface-qa` sweep owns keeping all artifacts current — so drift like today's `rpc-audit-followups` is caught weekly, not quarterly.

### D. Markdown runbooks — 1 index + targeted runbooks

- **`docs/operations/qa-loop.md`** (new) — the index/runbook for the whole funnel: what runs when, what each layer checks, thresholds, escalation, and how the layers feed the ledger + scorecard. Single source of truth for the loop (and onboarding doc if you ever add a hand).
- **Targeted runbooks** (thin, as needed): `data-quality-runbook.md`, `seo-runbook.md`, `incident-response.md` (the engineering plugin has a skill for this), `deploy-checklist.md`. Most can start as a paragraph and grow.
- Existing spine stays: CLAUDE.md (working memory), ledger.md (shipped/queued/declined), cron-schedule.md, handoffs, docs/health/.

---

## 5. Prioritized rollout (highest QA-value first)

1. **Wire `v_offer_sanity_flags` into `rpc-weekly-health-check`** (5-min extend, mirrors the v_fmv_sanity_flags wiring already done). — Cowork now.
2. **Build `rpc-offers-intelligence` artifact** (the queued one; gives the new pipeline a home + preps the public board). — Cowork now.
3. **Stand up `rpc-data-quality-sweep`** + its skill (the reconciliation layer — biggest correctness lever). — Cowork now.
4. **Stand up `rpc-surface-qa`** + skill (catches the artifact/brand/CX/SEO drift class found by hand today). — Cowork now (Chrome-capable).
5. **Build `rpc-qa-scorecard`** artifact (one-glance roll-up across all the above). — Cowork.
6. **Write `docs/operations/qa-loop.md`** runbook + extend the monitor/monthly tasks. — Cowork (doc) + CC if any route wiring.
7. **`rpc-dependency-advisory-digest`** (bi-weekly) — last, lowest urgency.

Items 1–5 are all Cowork-shippable (scheduled tasks, skills, artifacts, views) with no Claude-Code dependency. I can start at the top of this list immediately on your go — beginning with wiring the offer-sanity view into the weekly check and building the offers-intelligence + QA-scorecard artifacts.

---

## 6. End state

A weekly heartbeat where: the 3h monitor + nightly pass keep the platform live and self-healing; Tue/Thu/Mon sweeps reconcile the data, audit every user-facing surface, and keep deps/artifacts fresh; the monthly pass tends memory + strategy; everything funnels into one ledger and one scorecard; and a human only gets pulled in for the genuinely-risky or genuinely-strategic. The loop catches the drift instead of you.
