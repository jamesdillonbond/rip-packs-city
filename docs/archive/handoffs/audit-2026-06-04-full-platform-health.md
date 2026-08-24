# Full-platform health + surface audit — 2026-06-04

Interactive Cowork audit (Trevor-requested). Swept: DB security/RLS, pipelines, Sentry, Vercel, the overnight ledger/handoffs/known-issues, code (fabricated-data/brand/dead-code), the live site via Chrome (onboarding + funnel + app + entity + analytics), automations (cron / GitHub Actions / edge functions / scheduled tasks / artifacts), and responsive/mobile.

**Headline: platform is healthy and well-monitored.** Security is clean. Onboarding and the public insights funnel are excellent. One regression is escalating (R1, hydrator FK) and needs a Claude Code paste. The rest is small CX polish, two dead-infra cleanups, and a couple of operator cron tweaks. Nothing is auto-shipped this session — every actionable item is either route/.tsx code (handoff), destructive DDL on a live table (handoff), or operator cron (no safe+warranted DB migration was identified, and the ledger truncation hazard means I did not hand-edit ledger.md).

Companion handoff (paste-ready for Claude Code): `docs/handoff-2026-06-04-audit-fixes.md`.

---

## Health baseline (live, ~14:00 UTC)

| Signal | State |
|---|---|
| Security | **GREEN** — 0 RLS-off base tables; every anon/public write policy is service-role, user-scoped (`auth.uid()`), or a validated public-insert (the 4 tracked tables w/ size-cap CHECKs). No anon-readable view leaks PII. |
| Vercel | 20/20 prod deploys READY, 0 ERROR. prod `a50f3dd`. |
| Sentry | 2 unresolved, both single-event smoke-test blips (~9–10h old, no recurrence). Markable resolved after ~04:00Z 06-05. |
| `detect_stalled_pipelines()` | 1 — `snapshot-institutional-wallets` (N1, external cron miss, operator re-fire). |
| Pipelines (48h) | Healthy except: **R1** `topshot-moments-hydrator` (now failing every run — see below), `topshot-fmv-populate` 33% (M1, cron-peak pool timeouts), `cadence-payer-balance-check` (paused by design, N3). |
| DB size | 5,920 MB. |
| Automations | 11 scheduled tasks enabled+firing; 14 Cowork artifacts monitor-validated healthy; CI blocking + green. |

### Security detail (the two scary-looking numbers are both benign)
- "163 anon-write base tables" = default Supabase grants, **gated by RLS** (RLS is on for all base tables). Actual write policies: service-role-only, user-scoped, or validated public-insert. No hole.
- "26 anon-readable non-`security_invoker` views" = intentional public insight boards reading public data. Only `beta_feedback_stats` touches a user table (`support_conversations`) and it exposes **aggregates only** (`count`, `feedback_type/status`, `max(created_at)`) — no rows/PII. Leave as definer (making it `security_invoker` would break the public widget under RLS).

---

## P0 — escalating regression (hand off now)

### R1 — `topshot-moments-hydrator` blocked by `offers_moment_id_fkey`
- **Now failing on every run** (8 consecutive fails 12:52–14:02Z; was intermittent at onset ~11:22Z 06-04). Overall 48h ok-rate 93.8% and dropping.
- **Cause:** today's TS on-chain offers ship (`91ac5e1` + migration `audit_20260603_offers_onchain_idempotency_and_indexes`) created `offers.moment_id → moments.id` as **ON DELETE NO ACTION** (verified live). The hydrator deletes/re-keys `moments` rows; any batch touching a referenced moment is blocked.
- **Footprint:** 754 offers, 85 with `moment_id`, **64 distinct moments** referenced. Growing as the offers indexer runs → more batches blocked over time.
- **Impact:** MED→rising. No outage; TS moment hydration (metadata enrichment) stalls for affected batches → FMV/insights freshness degrades on those moments.
- **Fix (ready, safe — `moment_id` is nullable):** recreate FK `ON DELETE SET NULL ON UPDATE CASCADE`. It is a destructive `DROP CONSTRAINT` on the live offers-feature table → **Claude Code / Trevor**, not auto-shipped. Exact SQL + revert in the handoff doc.

---

## CX / wiring / brand (from the live crawl)

What's working (verified live): dashboard, `/login`, `/early-access`, `/insights` hub (live Flow Market Pulse), `/insights/squeeze` (filters+KPIs+table), the `squeeze-check` wallet tool (computed Trevor's wallet end-to-end), TS overview, sniper (outbound "View Listing" reframe intact), packs (EV table), an entity edition page (colon-slug fix holds, Best-offer cell populated), analytics. **AllDay "Best offer" parity is newly CLOSED** — `edition_offers` now has 203 NFL All Day rows, all with `highest_offer`, fresh (the `allday-offers-indexer` shipped today is working).

| # | Sev | Where | Issue | Owner / fix |
|---|---|---|---|---|
| C1 | MED | `/dashboard`, `/insights` | `<title>` doubles the brand: "Dashboard \| Rip Packs City \| Rip Packs City". Root template `%s \| Rip Packs City` (lib/seo.ts:18) re-suffixes titles that already include the brand. | CC — set `app/dashboard/layout.tsx:4` → `"Dashboard"`, `app/insights/layout.tsx:15` → `"Public Insights"`. Only these 2. |
| C2 | LOW | `/login` footer | Lists 4 collections; **UFC Strike omitted** (early-access correctly lists 5). | CC — `app/login/page.tsx:385` add `· UFC STRIKE`. |
| C3 | MED | analytics | Horizontal scrollbar / overflow at desktop width (a wide child table/row, not the top grid). Will be worse on mobile. | CC — find the wide child, wrap in `overflow-x-auto`. |
| C4 | LOW-MED | TS overview "TOP 5 SNIPER DEALS" | 4/5 deals show **$0 ask** + a discount % (sub-$1 commons rendering as "$0" reads as broken). Tied to inflated-common FMV (F-series). | CC — suppress/relabel `$0`-ask rows; or gate on ask ≥ $1. |
| C5 | LOW-MED | entity edition page | Artless editions render a **blank black image box** (no placeholder). ~54% TS thumbnail coverage. | CC — placeholder/poster for null `thumbnail_url`/`video_url`. |
| C6 | LOW | TS overview | KPI cards + deals render **blank ~5s** during load (no skeleton). | CC — loading skeleton. |
| C7 | LOW-MED | analytics Insider Signals (BETA) | "Insider buyback detected · **Unknown moment** · #140 · **—**" — events not resolving to moment name/value. | CC/data — resolve moment + value, or hide unresolved. |
| C8 | LOW | analytics | User-facing "● 1 pipeline stale" badge surfaces N1 to visitors. | CC — soften/hide for anon, or keep as intentional transparency. |
| C9 | LOW | global | Title strategy inconsistent (some pages have no brand suffix, e.g. overview). Cosmetic. | CC — optional normalize. |
| C10 | LOW | `/insights` hub | Surface labels skip "F" (A,B,C,D,E,G,H,I). Cosmetic. | CC — renumber or document. |

### Mobile / responsive
Tooling note: this Chrome instance floors the rendered viewport at ~963px, so I could not emulate a true phone live; assessment is from the responsive CSS. Most tables are handled (`overflow-x-auto` wrappers, `sm:hidden` card views). Real risks:

| # | Sev | File:line | Issue | Fix |
|---|---|---|---|---|
| M-1 | MED | `app/(collections)/[collection]/sniper/page.tsx:1566` | table `minWidth: 980` overflows tablets ~768–960px | `minWidth:"100%"` or responsive gate |
| M-2 | MED | `components/packs/PackTable.tsx:418` | `min-w-[900px]` visible <768px (card view is `sm:hidden`) | `md:min-w-[900px]` so tablets get cards |
| M-3 | LOW | `app/(collections)/[collection]/market/page.tsx:689,714` | fixed cell `minWidth` 110/180 widen columns | drop/responsive on <640px |
| M-4 | MED | analytics (see C3) | horizontal overflow — trace wide child | `overflow-x-auto` |

---

## Cleanup (outdated / unnecessary)

| # | Conf | Item | Action | Owner |
|---|---|---|---|---|
| K1 | HIGH | `.github/workflows/ts-listing-ingest.yml` (+ `scripts/ts-ingest.js`) | Dead — `*/5` cron calling the retired Flowty/TS-listings path (Flowty shut 2026-05-13, TS listings-indexer retired 2026-05-26). Delete. | CC |
| K2 | HIGH | `supabase/functions/flowty-proxy/` | Dead — no caller post-Flowty teardown. Delete. | CC/operator |
| K3 | MED | cron-job.org "RPC FMV Recalc Force Stale" | Still `3,13,23,33,43,53` (every 10m, set for the first full sweep, long done). Dial back to `8,28,48`. Verified safe 2026-05-30. | operator |
| K4 | LOW | cron-schedule.md drift | `classify-acquisitions-multicollection`, `lock-check-batch`, `run-insider-detectors` documented but not seen live 48h — confirm cron-job.org entries or prune doc. | operator/CC |
| K5 | LOW | 8 undocumented edge functions | `enrich-ufc-wallet`, `topshot-insider-detect-patterns`, `scan-pinnacle/ufc-wallet`, `special-serial-*`, `sales-serial-backfill`, `seed-ufc-editions` — clarify on-demand vs deprecated. | CC |
| K6 | LOW | `docs/code-todos.md` | Stale May backlog, mostly resolved — archive. | CC |

Code-side fabricated-data + brand-token audit came back **clean**: no invented numbers in live paths (Trade Hub stubs correctly gated behind `notFound()`/503; `/api/best-offers`, home STATS clean), no hardcoded `#E03A2F`/`Barlow Condensed` outside the sanctioned token defs + `ConsoleGreeting`.

---

## Queued blockers carried from the ledger (unchanged, for context)
M1 (fmv-populate cron peaks), PEV1 (pack-ev budget), N1 (institutional-wallets cron), N2 (`v_moments_needing_hydration` timeout), N3 (payer wallet/cron), L1 (league-drift wiring), PIN1 (NEXTJS-15 spike tuning), Q2 (golazos pack-ev idle), Q5 (smoke sales-lag rebase), Q6 (evm-ingest 429), Q7 (sandbox git push infra), Q8 (badge-sync upsert poison), F1/F2-TierB (serial>circ mis-key cleanup). See `docs/overnight/ledger.md`.

## Crawl coverage / limits
Walked: dashboard, login, early-access, insights hub + squeeze + squeeze-check (exercised), TS overview/sniper/packs, a TS edition page, analytics. Not individually walked (shared `[collection]` layout + consistent results give confidence): AllDay/Pinnacle/UFC/Golazos feature pages, Fast Break, RTR, `/moment`, `/share`, `/profile`. Mobile assessed from code (viewport-emulation unavailable in this browser).
