# Handoff — 2026-06-21 Full Platform Audit (Cowork)

Comprehensive audit + QA pass at Trevor's request, covering: security, database, pipelines / crons / GitHub Actions, FMV accuracy, Sentry + Telegram alerts, backfills, artifacts / scheduled tasks / skills, and a live Chrome QA of **every main user-facing page + 10 each of editions, packs, sets, teams**, plus mobile and the AI concierge.

**Verdict: platform is GREEN.** Security 0/0/0/0 (invariants `[]`, secdef-anon `[]`, 0 RLS-off tables), trust-health 9/9 ok, `detect_stalled_pipelines()` `[]`, `get_pipeline_alerts()` `[]`, Vercel 0 ERROR. Two real bugs were found and **fixed live this session** (one critical), and a set of mostly-cosmetic items are queued below with revert paths.

---

## Shipped live this session (Cowork, pushed to `main`, verified)

### 1. [CRITICAL] AI concierge restored — retired model migration (`f6ee7d47`)
- **Symptom:** the on-site AI concierge (`/api/support-chat`) returned *"Something went wrong on my end"* for every user. Verified live during QA on a basic FMV question.
- **Root cause:** the route called Anthropic model `claude-sonnet-4-20250514`, which **Anthropic retired on 2026-06-15** (one week ago). All requests to it now error; the route catches it and shows the generic fallback. The concierge had been dead for ~7 days.
- **Fix:** swapped both call sites (`messages.stream` + `messages.create`) in `app/api/support-chat/route.ts` to `claude-sonnet-4-6`. No logic/tool change.
- **Verified live (post-deploy):** concierge answered "Zion Williamson — Rising Stars (RARE): FMV **$18**, Confidence LOW, Last updated June 22 2026" — accurate (matches the edition page), current-dated, tool-calling, honest about confidence, with the "not financial advice" disclaimer intact.
- **Revert:** `git revert f6ee7d47` — **but do NOT**, the old model is retired and would re-break the concierge.
- **Follow-up:** there is no model-version monitor. Consider a tiny smoke check that pings the concierge model id (or a scheduled reminder) so the next Anthropic retirement is caught before users hit it.

### 2. [MED] Pack Reality intro median hardcoded, contradicting the KPI card (`f27bb70f`)
- **Symptom:** `/insights/pack-reality` hero said "Median pull value **$0.00**" while the MEDIAN KPI card showed **$1.66** — two different medians on the same page.
- **Root cause:** the hero lede hardcoded `<strong>$0.00</strong>`; every other number in the lede is dynamic, and the KPI correctly binds `median_pull_value_usd`. With ~41% of rips at $0 and ~45% in $0–10, the true median is a small positive number, so the KPI was right and the lede was wrong.
- **Fix:** bound the lede to `{fmtUsd(data?.stats?.median_pull_value_usd)}` in `app/insights/pack-reality/page.tsx`.
- **Revert:** `git revert f27bb70f`.

---

## Queued for Claude Code (code / route — test locally, ship to `main`)

### A. [HIGH] Refresh the 106 dead-IPFS TopShot thumbnails
- **Finding:** `ipfs.dapperlabs.com` is **100% dead** for this site (46/46 images failed on the base-set grid; confirmed persistent across reloads). **106 TopShot editions** still store `thumbnail_url` on that gateway — concentrated in the **oldest Series-1 / base-set editions, including the highest-value LeBron / Steph moments** — so they render as broken tiles (bare alt-text) on set/player/team grid pages. The other 9,061 TS thumbs use `assets.nbatopshot.com` and load fine; AllDay/Golazos/UFC use working hosts.
- **Find them:** `SELECT id, external_id, player_name, set_name FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND thumbnail_url ILIKE '%ipfs.dapperlabs.com%';`
- **Fix:** run `backfill-topshot-onchain-art` (force) over those 106 editions so `TopShotIPFSResolver.getCIDs` re-resolves them to working `assets.nbatopshot.com` URLs. **Operator-gated** (needs INGEST/CRON token; can't trigger from Cowork). Verify after: re-query the count → 0, and the base-set grid renders the top editions.
- Do **not** just null the URLs (that hides the most valuable editions); refresh them.

### B. [MED] Add `onError` image fallback to edition tiles
- **Finding:** when a thumbnail fails (the dapper-ipfs ones, or any future dead asset), the edition tile shows bare alt-text on a dark box instead of a placeholder. Collection-agnostic UX gap.
- **Fix:** add an `onError` → branded placeholder on the tile `<img>` in `components/entity/EditionsGridPaginated.tsx` (the `EditionTileCard`). Mirrors the existing `TileMedia`/`PackHeroArt` onError pattern. This makes A's broken images degrade gracefully even before the refresh lands.

### C. [MED] `remap_misattributed_topshot_sales` pg_cron times out every run + pg_cron failures are invisible
- **Finding:** the misattribution self-healer (pg_cron job `rpc-remap-misattributed-sales`, `23 */6 * * *`) **fails with statement-timeout (120s) on every run** (last 2 runs both 120s/failed). It does a full scan of `wallet_moments_cache` (~1.58M rows) ⋈ `sales`. Impact is **low** — conflation guard is converged (17) and the forward writers are fixed (`6b9e89a`) — but ~60 recent mis-keyed sales sit uncorrected, and a 100%-failing job is exactly the silent-degradation class the platform guards against.
- **Recommended fix (test rowcounts first):** window the `tgt` CTE to recent sales, e.g. add `AND s.sold_at > now() - interval '30 days'`. This preserves correctness (it only limits *which* sales each run checks; every re-key it does is still canonical-correct) and completes fast; the historical backlog was already drained 2026-06-21, and the job runs every 6h so a 30d window stays caught up. Keep `statement_timeout` at 120s as a backstop.
- **Also:** `detect_stalled_pipelines()` only watches `pipeline_runs`, **not** `cron.job_run_details` — so a failing pg_cron job is invisible to monitoring. Add a lightweight pg_cron-failure check (e.g. fold a `cron.job_run_details` scan into the daily monitor or a trust-health leg).
- **Current function body (for revert / reference):** `remap_misattributed_topshot_sales()`, SECDEF, `search_path=public`, `statement_timeout=120s` — `CREATE OR REPLACE` back to the current body to revert.

### D. [MED] Smoke-test RLS + FMV-tier checks false-positive under DB load → Telegram + Sentry noise
- **Finding:** `analytics-smoke` fails intermittently (5/24h) on `security_all_tables_rls_enabled` and `rpc_fmv_tier_pulse_collections`, and each fail fires a **Telegram alert** (`telegram_sent: true`) and surfaces Sentry **`JAVASCRIPT-NEXTJS-1C`**. These are **false positives** — RLS is genuinely clean (0 RLS-off tables, invariants `[]`); the checks just time out under DB load. This is alert-fatigue, not a real issue.
- **Fix:** harden the smoke checks against the saturation/timeout class — retry once on a query-cancel/timeout, or downgrade timeout-class fails to `warn` (mirrors the existing `isSaturationError()` sentinel pattern and the `SMOKE-RETRY` work). Files: `app/api/admin/analytics-smoke/route.ts` + `app/api/smoke-test/route.ts`. After it's quiet, resolve `NEXTJS-1C` with regression-arming.

### E. [LOW] AllDay edition "Found in these packs" thumbnails are dead
- **Finding:** on AllDay edition pages, the pack thumbnails in "Found in these packs" point to `storage.cloud.google.com/dl-nfl-assets-prod/tmp/NFLAD_PACKS_*` URLs that 404. Cosmetic, AllDay-only.
- **Fix:** `onError` fallback on those pack thumbnails (the same component from B covers it if shared), or null the dead AllDay pack `image_url`s.

### F. [LOW] Pack Reality stale hardcoded meta + share copy
- **Finding:** `app/insights/pack-reality/layout.tsx` (meta description / OG / twitter) and the share-text string in `page.tsx` hardcode **"128,220 rips / $0 median / 51%"**; live values are ~**147,181 rips / $1.66 median / 41%**. SEO + share copy is stale.
- **Fix:** update the numbers, or make the meta/share derive from live stats (editorial call — Trevor may prefer punchy fixed copy, in which case just refresh the numbers).

### G. [LOW] Per-edition pack EV column rounds sub-cent commons to `$0.00`
- **Finding:** on pack dist pages, the per-edition EV column shows `$0.00` next to a real FMV (e.g. `$2.29 FMV × 0.02% odds → $0.0005`). The math is correct but reads like missing data.
- **Fix:** display `<$0.01` (or `—`) when the per-edition EV is positive-but-sub-cent. File: `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`.

### H. [LOW] `/[collection]/badges` 404s + stale CLAUDE.md route doc
- **Finding:** `/nba-top-shot/badges` returns a 404. There's **no inbound link** (the collection nav is overview / collection / market / packs / pack-sniper / sniper / sets / analytics — no badges tab), so user impact is nil, but old bookmarks / SEO / the CLAUDE.md "Route structure" section still reference it. (Badges themselves display correctly on entity pages — verified.)
- **Fix:** either add a redirect `→ /[collection]/overview`, or remove the stale reference; update CLAUDE.md "Route structure" (badges tab gone, `pack-sniper` added as a collection tab).

---

## Operator items (Trevor / infra — can't be done from Cowork)

1. **Refresh the 106 dapper-ipfs thumbnails (item A)** — needs the INGEST/CRON-token-gated `backfill-topshot-onchain-art` route.
2. **Verify GHA `/api/ingest` cadence.** TS sales are fresh (on-chain indexer fired 6 min before audit), but the supplementary `topshot_gql` ingest path's last write was ~3.4h before the audit. The on-chain path covers sales, so this is low-risk, but confirm the GitHub Actions ingest workflow is still firing on schedule.

---

## Verified healthy — no action needed

- **Security:** invariants `[]`, secdef-anon-execute `[]`, 0 RLS-off public tables. Advisors: 1 ERROR (`security_definer_view`) + 82 intentional SECDEF-function warnings — all known/accepted, none anon-exploitable.
- **Badges:** recorded (10,893 `badge_editions`, 2,175 players, refreshed ~hourly) and **displaying correctly** on entity pages (RARE / Challenge Reward / etc. via the unified path; the empty `editions.badges` column is the known-harmless artifact).
- **Special-serial owners:** MV `topshot_special_serial_owners_mv` = 6,778 rows, refreshed via pg_cron (`13 4,16 UTC`, the 2026-06-22 re-home), and **displaying** in the "Special Serials" section on edition pages (16 owners w/ usernames on a sampled edition).
- **Wallet → username resolution:** **working** — owners render as `@username` where one exists, falling back to a truncated `0x…` only when no username is on record (correct behavior).
- **Internal linking / workflows:** breadcrumbs, edition→set/player/team/series/pack cross-links, insights-hub fan-out, "Parallel Printings", "Found in packs", profile links, and the `/insights` suite all link correctly. Strong shape.
- **FMV accuracy:** TS HIGH+MED **4,316** (24.9%), AllDay **889** (14.4%), Pinnacle HIGH+MED **759** (33.5%), `fmv_sanity_flags` 0, reconciles to edition counts (±small cataloging lag). Golazos/UFC are ~95% `NO_DATA` — **structural thin-market** (no sales), not a bug; a coverage item for the roadmap, not a fix.
- **Pipelines / crons / GHA:** all key pipelines firing on cadence; 24h fails are evm-429 (benign) + the smoke false-positives (item D) + the remap pg_cron (item C). pg_cron jobs healthy except remap.
- **Mobile:** no horizontal overflow on any page type down to 798px (the narrowest the audit window could reach); the team's recent pack-sniper mobile-card + column-hide work is live. **True 390px phone rendering could not be captured** (window clamped at 798px) — recommend a device-emulation spot-check (Claude Code / real phone) as the final mobile sign-off.
- **Artifacts / scheduled tasks / skills:** 16 Cowork artifacts (backing objects return rows), the scheduled-task fleet (monitor, nightly pass, weekly checks, candy tripwires, PAT-expiry reminder) all enabled and producing output.
- **Errors:** Vercel 0 ERROR (prod on the Next 16.2.9 security bump); Sentry 1 unresolved (NEXTJS-1C, the item-D false-positive).
