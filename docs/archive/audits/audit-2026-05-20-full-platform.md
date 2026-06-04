# Rip Packs City — Full Platform Audit

**Date:** 2026-05-20
**Scope:** Database, codebase, brand/UI consistency, and a live-site browser walkthrough of all 5 published collections plus top-level surfaces.
**Method:** Supabase MCP (project `bxcqstmqfzmuolpuynti`), static codebase analysis, and an authenticated Chrome walkthrough of `www.rippackscity.com` signed in as `jamesdillonbond`.

---

## Executive summary

The platform is fundamentally healthy: TypeScript compiles clean, RLS is enabled on all 172 public tables with 0 security errors, the pipeline fleet runs at ~97.6% success, and every primary page renders with real data. The product is genuinely substantial.

The audit surfaced **one user-facing crash, one structural cost/scaling risk, and a cluster of consistency and reliability defects.** The headline items:

1. **The `/[collection]/analytics` tab crashed on every collection** — a frontend `TypeError`. Fixed this session (see "Fixes applied").
2. **Two tables hold 84% of the 13.4 GB database** — `api_harvest_20260512` (9.9 GB) and `unmapped_sales` (1.97M unresolved rows / 1.4 GB). This is a real cost and scaling exposure on Supabase Pro Micro.
3. **The Flowty marketplace is offline**, leaving the Market tab empty and Sniper degraded across all collections — two core features are effectively non-functional.
4. **One pipeline (`wallet-backfill-multicollection-complete`) generates 61% of all errors** — 134 failures/day on Disney Pinnacle dispatch timeouts.
5. **No CI gate** validates build, types, lint, or Cadence tests — a broken build can reach `main`.
6. **The working tree is wedged** — 269 files of CRLF line-ending churn plus a stale `.git/index.lock`. This blocked committing fixes from the audit session (see "Git/environment blocker").

Nothing here is an emergency, but items 1–5 are worth scheduling deliberately.

---

## Severity index

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| F1 | Critical | UI | `/[collection]/analytics` tab crashes (`marketplace_listings.find` TypeError) | **Fixed — frontend guard + SQL migration** |
| F2 | High | DB | `api_harvest_20260512` = 9.9 GB (74% of DB) | Open — decision needed |
| F3 | High | DB | `unmapped_sales` = 1.97M unresolved rows (1.4 GB), resolver near-dead | Open — decision needed |
| F4 | High | Pipelines | `wallet-backfill-multicollection-complete` — 134 fails/day (Pinnacle dispatch) | **Mitigated — Pinnacle round-trip cap raised to 4** |
| F5 | High | Product | Flowty marketplace offline → Market tab empty, Sniper degraded (all collections) | Open — decision needed |
| F6 | High | Eng | No CI gate for build / type-check / lint / Cadence tests | **Fixed — CI workflow added** |
| F7 | High | UI | `/ufc-strike/*` invalid slug renders a broken Top Shot-skinned hybrid page | **Fixed — redirect to /ufc** |
| F8 | High | Brand | Analytics section uses a different design system than the rest of the app | Open |
| F9 | High | Eng | Git working tree wedged — 269-file CRLF churn + stale `index.lock` | **Partially fixed — `.gitattributes` policy added** |
| F10 | Medium | DB | Connection-pool exhaustion across ~8 pipelines | Open |
| F11 | Medium | DB | FMV quality thin — 49% `NO_DATA`, 2.5% `HIGH`; "100% coverage" is misleading | **Metric fixed (May 20 follow-up) — coverage now counts priced editions only; HIGH-confidence investment still open** |
| F12 | Medium | DB | ~920 Top Shot editions missing on-chain IDs; ~1,036 missing thumbnails | Open |
| F13 | Medium | DB | `editions.collection` text column drift vs `collection_id` (~590 rows) | Open |
| F14 | Medium | UI | AllDay collection page P&L row shows inconsistent "Current FMV" | **Fixed (May 20 follow-up) — binds cost-basis-subset FMV** |
| F15 | Medium | UI | Disney Pinnacle collection page — Wallet FMV blank despite 181 pins loaded | **Fixed (May 20 follow-up) — RPC column fix + route shape adapters** |
| F16 | Medium | Brand | `disney-pinnacle/` split-brain route (static override + dynamic) | Open |
| F17 | Medium | Brand | `panini-blockchain/` dead, unpublished, off-platform route reachable in prod | **Fixed — redirect added** |
| F18 | Medium | Brand | `global-error.tsx` off-brand (orange, not RPC red) | **Fixed** |
| F19 | Medium | Eng | ~1,500 ESLint problems; lint not gated; React 19 correctness smells | Open |
| F20 | Medium | Eng | ~12 MB tracked scratch/fixture files + 2 zero-byte junk files | **Partially fixed — `.gitignore` updated** |
| F21 | Medium | Eng | `ops-monitor.yml` schedule disabled (FMV-staleness monitor dormant) | **Fixed — schedule re-enabled** |
| F22 | Low | DB | `health_check()` reports Disney Pinnacle as all-zeros (counts wrong table) | **Fixed — `health_check` migration** |
| F23 | Low | DB | 362 unused indexes; 17 anon-executable SECDEF functions to re-verify | Open |
| F24 | Low | UI | "PIPELINE STATUS: CRITICAL" shown to end users on the overview page | **Fixed — labels softened** |
| F25 | Low | Product | Road to the Ring "Tonight's Pick" non-functional (no game odds) | Open |
| F26 | Low | Eng | Sentry SDK wired but no DSN — error page says "team notified" (false) | Open |

---

## 1. Git / environment blocker (F9)

The working tree on `main` shows **269 modified files** — but `git diff --stat` reports exactly `83,449 insertions / 83,449 deletions`. Byte inspection confirms this is **100% CRLF line-ending churn**: every working-tree file is `\r\n` while `HEAD` is `\n`. There are zero real content changes. The `.gitattributes` file (which only covers `*.cdc`) is itself part of the churn.

Separately, a stale **`.git/index.lock`** (0 bytes, dated 2026-05-20 03:23) cannot be removed from the audit session's Linux sandbox ("Operation not permitted" — the Windows side holds it).

**Consequence:** It is not safe to `git commit` from the audit session. Any commit would either be blocked by the lock or would pollute `main` with a 269-file CRLF flip. **Fixes from this audit have been applied to the working tree as file edits but NOT committed.** See "Fixes applied" for the exact clean commit sequence to run from your Windows Git Bash.

**Recommended permanent fix:** Add a real `.gitattributes` policy (`* text=auto eol=lf`), run `git add --renormalize .` once on Windows, and commit the normalization deliberately so the churn stops recurring.

---

## 2. Database

Supabase project `bxcqstmqfzmuolpuynti` — PRO Micro, **13.4 GB total**.

### 2.1 Storage concentration (F2, F3)

Two tables hold **84% of the entire database**:

| Table | Size | Notes |
|-------|------|-------|
| `api_harvest_20260512` | **9.9 GB** | The flowty_archive harvest table — 74% of the DB |
| `unmapped_sales` | **1.4 GB** | 1,978,570 rows; see below |

`unmapped_sales` breakdown by source:

| Source | Unresolved | Resolved |
|--------|-----------:|---------:|
| `flowty_archive_extractor` | 1,973,412 | 571 |
| `onchain` | 4,100 | 280 |
| `onchain_dapper_v1` | 119 | 87 |
| `onchain_dapper_v2` | 1 | 0 |

The resolver has cleared **~940 rows total, ever**, against ~1.98M queued. This is effectively a dead-letter queue that never drains — `flowty_archive_extractor` writes ~2M rows that cannot be matched to editions. CLAUDE.md known-issue #13 estimates a ~1.5 GB/month growth path; the real picture is worse because `unmapped_sales` is compounding on top.

**Recommendation:** Decide a retention policy. Either (a) build the high-volume extractors so rows actually resolve, or (b) prune `flowty_archive_extractor` rows from `unmapped_sales` past a cutoff once it is clear they are structurally unresolvable, and (c) finish the `prune_flowty_archive` work already started in the May 19 migrations. This is the single biggest lever on database cost.

### 2.2 Pipeline reliability (F4, F10)

`health_check()` reports 9,123 runs / 221 errors in 24h (97.6% success). But the errors are concentrated:

- **`wallet-backfill-multicollection-complete` — 134 failures (61% of all errors).** Every failure is `dispatch gaps: disney_pinnacle` — the Disney Pinnacle sync leg times out ("operation aborted due to timeout"). It is *intermittent* (some runs succeed), and the `round_trip_cap` for Pinnacle is only 2 vs 4 for other collections, so it gives up fast. The Pinnacle sync endpoint / `pinnacle-proxy` is the weak link.
- **`allday-unmapped-resolver` — 28 failures**, statement timeouts on `resolve_unmapped_sales_for_collection`.
- **Connection-pool exhaustion (F10)** — "Timed out acquiring connection from connection pool" appears across ~8 distinct pipelines (`sync-flowty-listings`, `wmc-fmv-populate`, `evm-transfers-ingest`, `golazos`/`ufc-listings-indexer`, `pack-events-ingest-backfill`, etc.). The performance advisor also raised `auth_db_connections_absolute`. With 76 distinct pipelines on a `*/20` cadence against a Pro Micro, the connection pool is saturated.

**Recommendation:** (1) Raise the Pinnacle `round_trip_cap` and/or harden the Pinnacle sync timeout so F4 stops dominating the error log. (2) Introduce a shared pooled client / PgBouncer transaction-mode pooling, or stagger pipeline cron offsets so 76 jobs don't all contend at `:00/:20/:40`.

### 2.3 FMV data quality (F11)

Most-recent FMV confidence per edition (24,440 total):

| Confidence | Editions | Share |
|------------|---------:|------:|
| NO_DATA | 11,895 | 48.7% |
| LOW | 9,374 | 38.4% |
| SALES_ONLY | 1,669 | 6.8% |
| HIGH | 618 | **2.5%** |
| STALE | 597 | 2.4% |
| MEDIUM | 164 | 0.7% |
| ASK_ONLY | 123 | 0.5% |

Overview pages advertise **"FMV COVERAGE 100%"** — technically true (every edition has a snapshot row) but materially misleading, since half are `NO_DATA`. For a product whose pitch is FMV pricing, 2.5% high-confidence coverage is the most important number to improve, and the "100%" metric should be reframed (e.g. "% HIGH/MEDIUM confidence").

### 2.4 Editions metadata gaps (F12, F13)

| Collection | Editions | No thumbnail | No player | No tier |
|------------|---------:|-------------:|----------:|--------:|
| nba_top_shot | 17,513 | 1,036 | 948 | 580 |
| nfl_all_day | 6,191 | 0 | 36 | 0 |
| laliga_golazos | 581 | 6 | 0 | 0 |
| ufc_strike | 147 | 0 | 0 | 0 |

~920 Top Shot editions are also missing `set_id_onchain`/`play_id_onchain`, which is why `topshot-moments-hydrator` fails ~16×/day with "no editions row for set_id_onchain=245...".

**Collection-column drift (F13):** `health_check()` counts editions by `collection_id` (UUID); a direct count by the denormalized `collection` text column disagrees — ~299 UFC and ~291 Top Shot editions are mis-tagged (CLAUDE.md known-issue #5, now quantified). 8 junk Disney Pinnacle rows also sit in `editions` (real Pinnacle data lives in `pinnacle_editions`, 476 rows). Treat `editions.collection` text as unreliable until reconciled.

### 2.5 Security & advisors (F22, F23)

Positive: **RLS on all 172 public tables, 0 security ERROR advisories.** 1,010 migrations tracked; the May 18–19 audit migrations are all present.

Lower-priority advisory items: 362 `unused_index` notices (write-amplification and disk on a Pro Micro — worth a cleanup pass), 24 `rls_enabled_no_policy` tables (mostly partitions — fail-closed, safe), **17 `anon`-executable SECURITY DEFINER functions** (re-verify against the May 3 anon-revoke — some may have crept back in), and 7 tables without a primary key.

`health_check()` itself has a blind spot (F22): it reports Disney Pinnacle as all-zero editions/sales/FMV because it counts the `editions` table, not `pinnacle_editions`. The ops signal is misleading — Pinnacle actually has 476 editions and 10,623 sales.

---

## 3. Codebase

### 3.1 Build & CI (F6)

`npx tsc --noEmit` **compiles clean** — good. But **no CI gate validates anything before code reaches `main`.** The 10 GitHub Actions workflows are all cron/curl jobs against the live site; `smoke-tests.yml` only POSTs a remote endpoint. Nothing runs `npm run build`, `tsc`, `eslint`, `vitest`, or `flow test` / `npm run test:cadence` on push. A broken build can ship undetected — and given the direct-to-`main` workflow, there is no PR review gate either. This is the highest-leverage process fix: a single CI job running `tsc --noEmit` + `npm run test:cadence` on push to `main`.

### 3.2 Lint health (F19)

`npm run lint` reports **~1,500 problems** (~1,384 errors + ~110 warnings). The bulk is `@typescript-eslint/no-explicit-any` (~1,107) — partly by design (CLAUDE.md mandates `any`-typed Supabase clients) — but it drowns out genuine signal: `react-hooks/set-state-in-effect` (~26) and a ref-during-render violation in `lib/warmup/WarmupContext.tsx` are real React 19 correctness smells. Recommend tuning the ESLint config (downgrade `no-explicit-any` to a warning in API routes) so the real issues are visible, then gate lint in CI.

### 3.3 Repo hygiene (F20, F21)

- ~12 MB of tracked scratch/fixture JSON: 11 `livetoken-portfolio*.json` files (CLAUDE.md known-issue #15), `test-gql.json`, `sniper.json`, `nftlocker-*.json`. None gitignored.
- **Two tracked 0-byte junk files at the repo root: `Invoke-RestMethod` and `main`** (likely PowerShell/git typos).
- `ops-monitor.yml` (F21) has its `schedule:` block fully commented out — the FMV-staleness monitor only runs on manual dispatch. Re-enable or delete it.
- Monolith files remain: `collection/page.tsx` (2,900 lines), `sniper/page.tsx` (2,485), `[collection]/analytics/page.tsx` (2,203), plus `api/sniper-feed` (2,215) and `api/support-chat` (1,852). These almost certainly explain the renderer freezes observed during the walkthrough (heavy main-thread work on hydration).

### 3.4 Known-issues drift

CLAUDE.md known-issue #1 is **overstated** — `lib/cadence/purchase-moment.ts` already has the `import FungibleToken` line and the `self.listing` ordering fixed (C1/C2 done); only the `commissionRecipient` panic and missing `post{}` block (H1/H2) remain. Sentry (known-issue #2) is wired but still has no DSN (F26) — so the error boundary's "our team has been notified" copy is currently false.

---

## 4. Brand & UI consistency

### 4.1 Token discipline (F8)

CLAUDE.md mandates: never hardcode `#E03A2F` or the brand fonts — always use tokens. In practice:

- **`#E03A2F` is hardcoded in ~80+ places across ~55 files.**
- **`'Barlow Condensed'` / `'Share Tech Mono'` are hardcoded ~284 times across 72 files.**

This is too large for a safe one-pass mechanical fix and should be a tracked cleanup epic, not a hot patch. The single most visible symptom is **F8: the entire `(analytics)` route group uses a different design system** — navy/slate cards, a non-condensed sans-serif, sentence-case copy — versus the black/red/Barlow-Condensed brand on every collection page. The Analytics section looks like a different product. This is the clearest "pages are not uniform" finding.

### 4.2 Route structure defects (F7, F16, F17)

- **F7 — `/ufc-strike/*` is an invalid slug.** The canonical UFC route is `/ufc`. Navigating to `/ufc-strike/overview` renders a broken hybrid: the layout chrome shows "NBA TOP SHOT" (basketball icon, Top Shot tabs, Top Shot ticker) while the page body correctly loads UFC data. The `[collection]` dynamic route accepts any slug and falls back to Top Shot when the layout's resolver doesn't recognize it. Add slug validation + a redirect (`ufc-strike` → `ufc`) or a proper 404.
- **F16 — `disney-pinnacle/` split-brain.** Static `disney-pinnacle/{collection,sniper}/page.tsx` overrides plus their own `disney-pinnacle/layout.tsx` shadow the dynamic `[collection]` route, while `overview`/`market`/`analytics` fall through to it. A user tabbing through Pinnacle silently crosses two layout implementations. Any header/nav change must be made twice.
- **F17 — `panini-blockchain/` is a dead route.** `published: false` in the registry, no `layout.tsx`, models an Ethereum/OpenSea collection (off-platform for a Flow product), yet is reachable in production with no redirect guard. Delete it or gate it.

### 4.3 Field-level data bugs found in the walkthrough

- **F14 — AllDay collection page P&L row is internally inconsistent.** It displays "Current FMV: $25,904.22" but computes P&L as −$74.15 (−84%), which only reconciles to a ~$14 current value. The Top Shot equivalent row is self-consistent; the AllDay row appears to bind the wallet-wide FMV into a slot that should show the cost-basis-subset FMV.
- **F15 — Disney Pinnacle collection page** shows "—" for Wallet FMV / Unlocked FMV / Locked FMV / Best Offer despite the wallet loading 181 pins and 18 franchises. The static-override page behaves differently (an "Analyze" button, empty FMV cards) from the dynamic collection page.
- **Top Shot collection page** — locked + unlocked moment counts (10 + 40 = 50) do not reconcile to the 14,260-moment total; the acquisition-source breakdown (6,939 + 6,643 + 312 = 13,894) also does not sum to 14,260. May be a mid-load artifact on a very large wallet — worth verifying with a fresh load.
- **"BEST OFFER TOTAL" is empty ("—")** on every collection page — consistent with the dead Flowty offers ingest (CLAUDE.md known-issue #3).

### 4.4 Degraded features observed (F5, F24, F25)

- **F5 — Flowty marketplace offline.** The Market tab shows "Flowty marketplace currently offline → 0 of 0 listings" on every collection; Sniper shows 0 deals. These two core features are non-functional because their listings source (the Flowty NFTStorefront) is dormant. The Disney Pinnacle sniper does show rows, but they are computed off the known bogus uniform $1 Flowty floor (CLAUDE.md known-issue #4) with blank pin names and `#0` serials — i.e. meaningless "deals." The product needs a listings source that isn't dead Flowty.
- **F24 — "PIPELINE STATUS: CRITICAL"** is rendered to end users on the Top Shot overview page (FMV data age 2h). Internal ops health should not surface as a user-facing red alarm; cap the displayed status or hide it from non-admins.
- **F25 — Road to the Ring "Tonight's Pick"** shows "No game odds available" — the NBA odds feed is not flowing (ties to CLAUDE.md known-issue #8, NBA stats unreachable from Cloudflare Workers).

### 4.5 Positive notes

Every primary page renders with real, rich data. Fast Break, the Pack EV table, Insider Signals, the dashboard trophy case, the admin console, and the pricing page all work and look on-brand. FMV freshness on AllDay/Golazos/UFC/Pinnacle overviews is HEALTHY (3–16 min); only Top Shot was stale (2h) at audit time.

---

## 5. Fixes applied this session

Twelve changes were applied across the session addressing eleven findings — frontend fixes, three database migrations, and config/workflow/hygiene changes. Code changes were applied to the working tree as file edits and verified with `npx tsc --noEmit` (exit 0); **they are NOT committed** (see §1 — use the sequence below). The database migrations were applied directly to Supabase and are live now.

**Frontend (working tree — uncommitted):**

1. `app/(collections)/[collection]/analytics/page.tsx` — `Array.isArray` guard on `marketplace_listings` before `.find()`. Stops the crash that took down the Analytics tab on every collection (F1).
2. `components/analytics/ListingsDashboard.tsx` — same guard before `.map()`; this was a latent identical crash on `/analytics/listings` (F1).
3. `app/global-error.tsx` — error-page accent changed from orange `#f97316` to RPC brand red `#E03A2F` (F18).

**Database (applied live to Supabase):**

4. Migration `audit_20260520_analytics_listings_summary_marketplace_array` — the `analytics_listings_summary` function now returns `marketplace_listings` as a JSON **array** of `{collection, ...}` objects. It previously used `jsonb_object_agg` (a keyed object) and defaulted to `{}` when empty, which is the true root cause of F1. The function now matches its TypeScript type and both consumers, so the Listings/Analytics surfaces render real marketplace data instead of being guarded-empty. Verified: the function now returns a 3-element array.

**Config & workflows (working tree — uncommitted):**

5. `.github/workflows/ci.yml` (new) — CI gate running `tsc --noEmit` and `npm run test:cadence` on every push and PR to `main` (F6).
6. `.gitattributes` — proper `* text=auto eol=lf` policy to stop the recurring CRLF churn (F9). Requires a one-time `git add --renormalize .` (see below).
7. `next.config.ts` — redirects added: `/ufc-strike/*` → `/ufc/*` (F7) and `/panini-blockchain/*` → `/nba-top-shot/overview` to neutralize the dead route (F17).
8. `.github/workflows/ops-monitor.yml` — re-enabled the commented-out `schedule:` block so the FMV-staleness monitor runs again (F21).
9. `.gitignore` — added the scratch/fixture patterns so they stop being tracked (F20). Actual removal needs `git rm --cached` (in the sequence below).

**Reliability & UX (second pass):**

10. `app/api/wallet-backfill-multicollection/route.ts` — raised the Disney Pinnacle sync round-trip cap from 2 to 4 (the same in-pattern mitigation already applied to `nfl_all_day`), so intermittent-slow Pinnacle wallets get more checkpoint-resumed attempts before being recorded as a dispatch gap (F4). This reduces the failure rate; the deeper fix remains Pinnacle sync performance.
11. Migration `audit_20260520_health_check_pinnacle_coverage` — `health_check()` now counts Disney Pinnacle editions/sales from `pinnacle_editions`/`pinnacle_sales` instead of the empty `collection_id` query (F22). Verified: now reports 476 editions / 10,633 sales instead of zeros.
12. `app/(collections)/[collection]/overview/page.tsx` — the user-facing FMV-freshness pill no longer shows the alarming internal word "CRITICAL"; labels are now LIVE / DELAYED / OUTDATED (F24).

A **weekly platform health-check** scheduled task was also created (runs Mondays) to surface pipeline failures, DB growth, and FMV staleness automatically.

### Clean commit sequence (run from Windows Git Bash, on `main`)

Two commits — the audit work first, then the line-ending normalization separately.

```bash
cd /c/Users/TDill/rip-packs-city

# 1 — the audit fixes (stage explicitly so the CRLF churn is NOT swept in)
git rm --cached -- "Invoke-RestMethod" "main"
git rm --cached -- livetoken-portfolio*.json test-gql.json sniper.json
git add .gitattributes .gitignore next.config.ts \
        .github/workflows/ci.yml .github/workflows/ops-monitor.yml \
        "app/(collections)/[collection]/analytics/page.tsx" \
        "app/(collections)/[collection]/overview/page.tsx" \
        app/api/wallet-backfill-multicollection/route.ts \
        components/analytics/ListingsDashboard.tsx \
        app/global-error.tsx \
        docs/audits/audit-2026-05-20-full-platform.md \
        docs/roadmap-2026-05.md
git commit -m "fix(audit): analytics crash guards, CI gate, route redirects, repo hygiene"
git push origin main

# 2 — normalize line endings repo-wide (now that .gitattributes is committed)
git add --renormalize .
git commit -m "chore: normalize line endings to LF"
git push origin main
```

After step 2 the 269-file CRLF churn is resolved permanently. Delete the now-untracked junk files (`Invoke-RestMethod`, `main`, the `livetoken-portfolio*.json` fixtures) from disk at your convenience.

---

## 6. Prioritized punch list

**Now (this week)**
- Commit this session's fixes via the two-commit sequence in §5 — *applied to the working tree, awaiting commit.*
- ~~Apply the SQL fix for `analytics_listings_summary`~~ — **done** (migration applied live).
- ~~Add a CI gate~~ — **done** (`ci.yml`). ~~Re-enable `ops-monitor.yml`~~ — **done**. ~~Add `.gitattributes` policy~~ — **done**.
- Run `git add --renormalize .` once on Windows to clear the CRLF churn for good (F9).
- ~~Fix the Pinnacle dispatch leg in `wallet-backfill-multicollection-complete`~~ — **mitigated** (round-trip cap raised 2→4); the deeper fix is Pinnacle sync performance (F4).

**Next (this month)**
- Decide `flowty_archive` / `unmapped_sales` retention and reclaim DB space (F2, F3).
- Stagger pipeline crons / add connection pooling (F10).
- Redirect `/ufc-strike` → `/ufc` and add slug validation (F7).
- Reframe the "FMV COVERAGE 100%" metric; invest in HIGH-confidence FMV coverage (F11).
- Decide the Flowty marketplace story — Market/Sniper need a live listings source (F5).
- Re-unify the Analytics section design system with the main brand (F8).
- `git rm` the 12 MB of tracked fixtures; re-enable or delete `ops-monitor.yml` (F20, F21).

**Later**
- Resolve the `disney-pinnacle` split-brain and delete `panini-blockchain` (F16, F17).
- Brand-token cleanup epic — `#E03A2F` ×80, fonts ×284 (F8 detail).
- Backfill the ~920 Top Shot editions missing on-chain IDs; reconcile `editions.collection` drift (F12, F13).
- Set the Sentry DSN so error reporting actually works (F26).
- Refactor the monolith pages (the likely cause of the renderer freezes).
- Drop unused indexes; re-verify the 17 anon SECDEF functions (F23).

See `docs/roadmap-2026-05.md` for the strategic framing of where these sit.
