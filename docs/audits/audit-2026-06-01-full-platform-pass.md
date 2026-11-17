# Rip Packs City — Full-Platform Audit & Health Pass (2026-06-01, Cowork)

Cross-surface sweep at Trevor's request: threads, audits, roadmaps, outputs, artifacts, scheduled tasks, DB, cron, GitHub Actions, website, skills — plus the specific asks (highest edition offer on moments, all 6 entity-page types dialed in for Top Shot + All Day, security + CX, onboarding, mobile, cleanup).

**Bottom line: the platform is GREEN and most of what a fresh audit would flag is already fixed (the 2026-05-31 `a79b778` pass + the 06-01 inserts landed it).** I shipped 2 low-risk DB fixes live and verified them; everything else is a focused code handoff or operator note. The one material *product* gap is **All Day has no offer data source**, so "Best offer" is a permanent em-dash on All Day moment/edition pages (the RPC is correct — it's missing ingest, not broken wiring).

---

## 1. Shipped live this pass (DB, verified end-state — not just the ack)

**S1 — `v_moments_needing_hydration` rewritten to kill the hydrator timeouts.** `audit_20260601_v_moments_needing_hydration_materialized_cte`.
The hydration candidate view forced a pathological **Merge Anti Join** (deep-walking `idx_moments_nft_id` to prove 146,788 non-matches), which intermittently tripped the `topshot-moments-hydrator` statement timeout (3/132 runs/24h — today's monitor C2). Wrapped the candidate filter in a `MATERIALIZED` CTE optimization fence so the planner can't merge-join.
- Verified: rowcount **146,792 → 146,792 (identical)**; plan flipped **Merge Anti Join → Nested Loop Anti Join over the CTE** (batch read ~588ms → ~167ms; full drain now single-pass hash); grants preserved (anon/authenticated/postgres/service_role intact); output columns unchanged.
- Revert: `CREATE OR REPLACE VIEW` with the original body (in the migration comment / this doc's handoff).

**S2 — `funnel_events` anon INSERT size caps.** `audit_20260601_funnel_events_anon_insert_size_caps`.
The anon insert policy was `with_check = true` (unbounded) — the only one of the 5 anon-INSERT tables lacking caps. Bounded each text column (event_type ≤64, wallet_address ≤80, session_id ≤128, surface ≤64, referrer ≤512), matching the `outbound_clicks` pattern. Real funnel payloads are well under these.
- Verified: policy `with_check` now carries the caps. Revert: `ALTER POLICY funnel_events_anon_insert ON public.funnel_events WITH CHECK (true);`

---

## 2. Health snapshot (all green)

| Area | State |
|---|---|
| Security | **0 / 0 / 0** — 0 RLS-off public base tables; 0 anon/authenticated write *policies* on sensitive tables; 44 anon/auth-callable SECDEF fns all intentional read-only/owner-scoped; 0 SECDEF missing `search_path`. `check_public_security_invariants()` = 0. |
| Pipelines | `detect_stalled_pipelines()` = `[]`. All `ok=false`/24h are transient connection-pool/statement timeouts at the cron rush, self-recovering. The only repeating one (`topshot-moments-hydrator` 3×) is exactly what S1 fixes. |
| FMV | Fresh (~minutes). TS HIGH+MED **884** (236 HIGH / 648 MED); AllDay HIGH+MED **261** (51 / 210). NO_DATA improving (TS 4,954, ↓ from 5,109). |
| Offers | `edition_offers` **8,860 rows, 100% Top Shot**, 5,568 with offer>0, fresh 20:01 UTC (sweep firing 43×/24h, all ok). |
| Sentinel | TS-UUID-keyed editions/48h = **0** (integer-key writer holding). |
| unmapped_sales | 147 open (flat). DB 5,926 MB (normal growth). Vercel 20/20 READY. |

---

## 3. Edition-offer display (your specific ask) — verified live

- **Top Shot: WORKS.** `/nba-top-shot/edition/8:133` (LeBron Cosmic) renders **BEST OFFER $5,000** (1h ago) alongside TOP SHOT ASK $25,000. `get_edition_high_offer` reads `edition_offers` → `badge_editions` fallback; 5,568 TS editions have a live offer.
- **All Day: structural data gap, not a code defect.** `edition_offers` is 100% Top Shot; `badge_editions.highest_offer` is 0/1,572 for All Day. So on every All Day moment/edition the "Best offer" cell is a permanent **—**. `get_edition_high_offer` is collection-agnostic and would surface All Day offers the instant a source exists. Verified live on `/nfl-all-day/edition/446` (Tom Brady Base): FMV $20.25 HIGH, FLOOR $15.00, recent sales + chart all correct — but **BEST OFFER —** and **TOP SHOT ASK —**.
  - **Proper fix (handoff H4):** build an `/api/cron/allday-offers-sweep` mirroring the TS one against All Day's marketplace GQL, writing `edition_offers` rows for `dee28451…`.
  - **Interim CX fix (handoff H1):** hide the "Best offer" stat for collections with no offer source instead of rendering a bare em-dash.

---

## 4. Entity-page wiring — Top Shot vs All Day parity

Audited all 7 templates (collection grid, player, team, set, series, pack-dist, pack-simulator, moment, edition). **FMV, floor, recent sales, FMV history, badges, circulation, tier, sets, parallels, special-serials all reach parity TS = All Day.** The "All Day lags" pattern is concentrated entirely in **offers, video, and one ask field/label**:

| Gap | TS | All Day | Fix |
|---|---|---|---|
| Best offer | ✓ (5,568 ed.) | **— always** (no data source) | H1 (hide) / H4 (ingest) |
| "Top Shot ask" label | correct | **says "TOP SHOT ASK" on an NFL page** + often empty | H2 (collection-aware label) |
| `cross_market_ask` | n/a | **2,446 editions computed, never surfaced** (`get_edition_detail` standard path omits it; only Pinnacle path selects it) | H3 (add to RPC jsonb + render) |
| Hero / hover video | clip | **none** (`video_url` 0/6,191) — handled gracefully (static thumb) | data backfill (separate, low pri) |
| "Found in these packs" | (n/a on tested ed.) | shows generic **"Pack"** labels on `/nfl-all-day/edition/446` | H5 (verify get_edition_in_packs name; likely null name / render) |
| `league: "NBA"` hardcode | ok | All Day rows tagged "NBA" in collection-grid server mapper (L940) | H6 (cosmetic, monolith) |

No new fabricated-data landmines (the known `/api/best-offers`, trade-hub `fcl-submit`, home STATS are all already fixed). Brand tokens clean on all entity templates; bare `#E03A2F`/`'Barlow Condensed'` survive only in the legacy monolith pages (`collection/page.tsx`, `sniper/page.tsx`) and canvas/SVG contexts where CSS vars can't resolve.

---

## 5. Onboarding + mobile (verified)

- **Onboarding CTAs are correctly wired to public destinations** (source-verified; the P0 funnel leak is closed): wallet-paste → `router.push('/share/<wallet>')` (public results card), collection tiles → `/<id>/overview` (opened to anon in a79b778), primary beta CTA → `/early-access`. No anon CTA dumps to `/login` at the activation moment.
- **Public surfaces render end-to-end:** `/insights/deals` loads 70 deals (median 22% off) with FMV+confidence+floor+mint. *Mild CX note:* ~5–7s to first populated paint (shows "LOADING…" then KPIs 0 then fills) — consider a skeleton row or faster initial fetch.
- **Mobile:** meta viewport correct (`width=device-width, initial-scale=1`), no horizontal overflow at desktop; responsive scaffolding confirmed in `app/rpc-tokens.css` — `@media (max-width: 640px)` collapses `.rpc-entity-hero` to 1-col and `.rpc-scroll-x` wraps dense tables (the a79b778 fixes are live). *Caveat:* the connected desktop Chrome wouldn't accept a true sub-640 viewport (resize_window stayed 1920), so this is source + meta verification, not device emulation — worth a real phone spot-check of an edition page + an insights board.

---

## 6. Automation & cleanup

- **GitHub Actions (11):** all live/healthy; CI gates (typecheck, smoke, cadence-lint) all blocking — good posture. `rpc-pipeline.yml` still labels 4 steps "Flowty listings" (routes live, names misleading — cosmetic). Verify `ts-listing-ingest.yml`/`scripts/ts-ingest.js` + `FLOWTY_PROXY_TOKEN` still hit a live feed post-Flowty-shutdown.
- **Cron:** `/api/cron/offers-sweep` is firing 43×/24h all-ok but is **absent from `cron-schedule.md`** and its route header still says "operator must add the cron" (stale). `evm-transfers-ingest` also missing from the doc. `FMV Recalc Force Stale` cron dial-back (`3,13,…` → `8,28,48`) is overdue (first sweep long complete).
- **Scheduled tasks (9):** healthy. One spent one-shot `chain-abstraction-phase-d-f-closeout` already fired + disabled (safe to delete). `rpc-weekly-health-check` vs `rpc-weekly-health-report` overlap — confirm both are wanted.
- **Artifacts (11):** all RPC-branded, self-re-querying, no duplicates.
- **Skills:** RPC skills (rpc-data/handoff/migration/insights-qa) current & accurate. For a solo dev, `customer-support:*`, `brand-voice:*`, `marketing:email-sequence/campaign-plan` are irrelevant noise — optional uninstall.
- **Dead code:** only **`lib/pro/gate.tsx`** is unambiguously safe to `git rm` (0 importers; real gate is `components/ProGate.tsx`). Fixtures (`livetoken-portfolio*.json` etc.) are already untracked — CLAUDE.md #15 is wrong. The 18 Phase-D shims stay (833 importers — defer).
- **Doc drift:** CLAUDE.md #14 sniper line count (~2,485 → ~2,070); #15 mark resolved (fixtures untracked); scrub `topshot_rookies_board` → `topshot_2025_rookie_index` (the former doesn't exist).

---

## 7. Prioritized next actions

**Code handoff (see `handoff-2026-06-01-audit-pass.md` — can't push from Cowork):**
1. H1 — hide "Best offer" stat when no offer source (kills the All Day em-dash). *small*
2. H2 — collection-aware "ask" label ("Top Shot ask" → "Floor ask"/"All Day ask"). *small*
3. H3 — surface `cross_market_ask` for All Day (RPC jsonb + render) — closes 2,446-edition ask gap. *medium, DB+code*
4. H5 — verify/fix All Day "Found in these packs" name rendering. *small, verify first*
5. H6 — fix `league:"NBA"` hardcode in collection monolith. *cosmetic*
6. Cleanup: `git rm lib/pro/gate.tsx`; doc fixes (CLAUDE.md #14/#15, rookies view name, cron-schedule.md offers-sweep + evm-transfers-ingest, offers-sweep route header).

**Bigger / deferred:**
7. H4 — All Day offers-sweep ingest (the real fix for All Day best-offer). *medium ingest build*
8. Operator: dial back `FMV Recalc Force Stale` cron; delete spent `chain-abstraction-phase-d-f-closeout` task; (optional) mark Sentry `NEXTJS-1B` resolved (24h+ clean).

**No paywall / promo work** — RPC is pre-traction; that bar (50+ WAU) is unchanged.
