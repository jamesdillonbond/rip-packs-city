# Claude Code handoff — 2026-07-10 round 3 (genuine remainder)

## Context
Third Cowork pass of 2026-07-10. After the full audit + CC's own round (home ingests, misattrib MV, UFC sniper banner), Cowork closed several more items live. HEAD should be at `ab3ee8b` (or later). This handoff is only what genuinely needs machine access, a flaky secret-bearing console, or a product call Cowork shouldn't make alone.

**Shipped live by Cowork this round (already on main / applied):**
- `ab3ee8b` fix(ufc): removed the fabricated `2025-07-30` Aptos migration date from ALL user-facing copy (banner `components/marketplace-status/MarketplaceStatusBanner.tsx`, moment-page note `app/moment/[id]/page.tsx`, sets methodology `lib/analytics/methodology.ts`). The date was internally impossible (our own data: last Flow sale 2026-05-13; ufcstrike.com still *announcing* the migration present-tense with `/migrate` 404 as of 2026-07). Replaced with verifiable framing: "migrating to Aptos; Flow trading frozen since May 2026." **DB companion applied via MCP:** `collection_config.metadata.marketplace.aptos_migration_date` → null, `notes` reworded ("exact migration date unconfirmed").
- `audit_20260710_revoke_anon_misattrib_mv` (DB): REVOKEd anon/authenticated SELECT on `mv_topshot_misattrib_candidates` (CC's misattrib MV landed with the Supabase default anon grant → PostgREST-reachable internal mapping; the invariant fns don't cover matview grants). anon SELECT now false.

**Key reframe from Cowork's data probe — the "AllDay ask source product decision" is mostly a non-problem:** AllDay asks are healthy. `cached_listings_v2` carries **16,648 open AllDay listings, fresh to 14:23Z** from 3 on-chain sources (`direct`, `direct_v1`, `direct_v2`), and **4,048 / 6,190 AllDay editions (65%) have a live ask**. AllDay FMV is fresh (`allday_fmv_stale_hours` 0.2). The dead `allday-listing-cache` marketplace-GQL leg (the WAF-403 one) is **redundant supplementary enrichment, not the primary ask path** — so this is "remove dead weight," not "migrate the ask source." See item 2.

Claude Code's direct file inspection wins over this doc and `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## 1. Disable the dead UFC live-market crons on cron-job.org (operator/CC — flaky secret-bearing console)
UFC Strike is migrating to Aptos; the Flow market is dead (last sale 2026-05-13). Four UFC entries exist on cron-job.org (verified live, IDs harvested):
| Job ID | Title | Classify |
|---|---|---|
| 7620381 | RPC UFC Listings Indexer | **DISABLE** — scans Flow listings, finds nothing |
| 7485721 | RPC UFC Strike Pipeline | **DISABLE (verify first)** — the main UFC sales/ingest pipeline; confirm its target route before disabling |
| 7804392 | RPC UFC Enrichment Drain | **KEEP-or-verify** — likely enriches existing historical rows |
| 7585607 | RPC UFC Stub Thumbnail Resolver | **KEEP** — resolves thumbnails for historical UFC moments (keeps the 518 historical editions displaying) |

Cowork did NOT disable these: the enable/disable toggle is behind the EDIT→Common-tab flow, which the console drives unreliably (documented silent-ignore class), and the name→route mapping needs confirming so we don't kill historical enrichment. **CC path:** for each, open `console.cron-job.org/jobs/<id>` COMMON TAB ONLY (never the Advanced tab — it holds the Authorization secret), read the target URL to confirm it's a live-market UFC route, toggle "Enable job" off, Save, and verify on the jobs LIST page that "next execution" goes blank. Leave the Vercel UFC crons (historical backfills) running — 813k UFC sales stay fresh.

## 2. Delete the redundant dead allday-listing-cache marketplace-GQL leg (LOW, ingest-route cleanup)
Now proven redundant (item Context above). The marketplace-GQL leg in `app/api/allday-listing-cache/route.ts` (`fetchAlldayMarketplaceAllPages`) 403s upstream from BOTH the direct endpoint AND the topshot-proxy worker (`/allday-consumer` is CF-WAF-blocked at the worker egress too — probe returns 403 with real secret; 401 without). It contributes 0 rows and only logs `GQL page 0 http 403` noise every `*/20`. Options: (a) remove the marketplace-GQL leg entirely (keep the on-chain listing path + badge low_ask clearing), or (b) leave it (harmless log noise). Cowork's `5039463` repointed its fallback to the worker route — that repoint is a **no-op** (dead→dead); if you remove the leg, also drop that fallback line. **Do NOT** spend effort "migrating FMV to Atlas" or "adopting low_ask as ask source" — the on-chain path already covers AllDay asks (65% edition coverage, fresh).

## 3. Home-machine Task Scheduler durability (Trevor decision)
"RPC Deal Board Ingest" + "RPC AllDay Badge Ingest" are "run only while logged on" → they die on reboot/logoff (why they stopped ~07-07; CC found+fixed the AllDay one's hung-node root cause in `211abc0`). Switching each to "Run whether user is logged on or not" makes them survive logoff but needs the machine always-on and stored credentials. Trevor's call.

## 4. Standing product/pricing items (unchanged — deliberately NOT auto-shipped)
- **OFFER-SANITY durable raise:** `edition_offers.highest_offer = GREATEST(existing, max open offer WHERE offer_type='edition')` as a recurring cron, landing WITH its `offer_sanity_max_gap` trust-health monitor (else it breaches chronically). Semantics locked 2026-06-09 (edition-cell raised only by edition-grain offers). ~30 editions actionable, max gap ~$167. Trevor's product call + operator wiring — see ledger "OFFER-SANITY-RAISE".
- **AllDay serial/jersey FMV port** — biggest parity win; TS `serial_fmv_estimate` power+jersey models exist, AllDay special-serial owners board is live. Needs `editions.jersey_number` coverage for AllDay first. Spec before building.
- Soft-404 noindex on streamed `notFound()` pages; recharts `width(-1)` SSR warning (FmvHistoryChart min-height). Both LOW.

---

## Guardrails
- Direct to `main`, no branches/PRs. PowerShell `git` (Git Bash commit can silently no-op); verify `git rev-list --count origin/main..HEAD` = 0 after push.
- `curl` no-ops silently in Git Bash for Vercel REST — PowerShell `Invoke-WebRequest`. Vercel Pro `maxDuration` cap 800s (higher → invisible ERROR).
- cron-job.org: COMMON tab only, never Advanced (secrets); verify persistence on the jobs LIST page, not the edit field.
- `npx tsc --noEmit` before push; confirm Vercel READY + smoke pass.

## Expected end state
Dead UFC live-market crons disabled (historical enrichment kept); allday-listing-cache dead leg removed or accepted as noise; Task Scheduler durability decided. Trust 16/16, security 0/0/0/0.
