# Handoff — SEO follow-ups #2 (2026-06-05)

Plain text on purpose (no code fences) so it pastes clean from an iPhone. Companion to the shipped docs/handoff-2026-06-05-seo-internal-linking.md (commit 549ddfa, live) and the audit docs/audits/seo-technical-audit-2026-06-05.md.

CONTEXT

The internal-linking pass is live and anon-verified across all 5 collections (footer Insights/Collections columns on every entity page; overview catalog fan-out works on TS, All Day, Golazos — ~18 real edition links each; edition "Featured in Insights" block resolving; /moment->edition canonical). Cowork also shipped one live DB action and one interim automation: it refreshed the 5-day-stale cross_collection cohort tables, and created a daily Cowork scheduled task rpc-cross-collection-refresh as an interim refresh.

This handoff covers the next SEO lever found while verifying the ship, plus two smaller items. Everything here is .tsx/route code (Cowork can't push it). All link-only / read-only / additive — no auth, pricing, FMV, ingest, or sniper logic.

Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. I verified render mode + data source by grep and by fetching the live pages; the per-page row markup I did NOT open line-by-line, so locate the board's row-render and the existing client fetch in each file before changing it.

---

ITEM A (P1 — the next real SEO lever) — Server-render the insights board content

The finding: all 10 insights board pages are "use client" and fetch their data client-side. Verified two ways — (1) grep: every app/insights/<surface>/page.tsx has "use client" on line 1 and a useEffect + fetch("/api/public/insights/<surface>"); (2) live fetch of /insights/squeeze and /insights/rookies returns server HTML containing "Loading…" and 0/— KPIs, with the ranked rows and the drill-down links injected only after JS.

Why it matters: these pages' entire SEO thesis is "unique data no competitor has" (effective-supply squeeze, rookie cohort, below-FMV deals, first-mint trophies). Right now that data — and the insights->entity drill-down links shipped in the last pass — exists only in the client-rendered DOM. Google does render JS, but it's deferred and less reliable, and at crawl time the page's actual text is just "Loading…" + the methodology blurb. For a pre-traction site trying to rank unique content, the content needs to be in the server HTML. This is the highest-value remaining SEO change; the internal-linking pass widened the entrance, this makes the destination pages actually rankable.

The change (per page): convert each board to render its initial rows server-side, keeping client interactivity as progressive enhancement. The data layer is already built — app/api/public/insights/<surface>/route.ts and the backing views exist — so:
- Make page.tsx an async server component that fetches the initial top-N rows server-side. Cleanest: extract the route's query into a shared lib function (e.g. lib/insights/<surface>.ts) callable from BOTH the existing /api/public/insights/<surface> route AND the page, so there's one query definition. (Or, simplest, have the server page read the backing view directly via supabaseAdmin, exactly like app/(collections)/[collection]/edition/[slug]/page.tsx already does for its RPCs.)
- Render the top N rows (50-100) as real HTML, including the drill-down Links the last pass added: squeeze/deals/first-mint/offer-spread row -> /nba-top-shot/edition/{encodeURIComponent(external_id)}; rookies row -> /nba-top-shot/player/{encodeURIComponent(slugifyName(player_name))}; set-squeeze row -> /nba-top-shot/set/{encodeURIComponent(slugifyName(set_name))}.
- Keep the existing client component for sort/filter/load-more, but pass the server-fetched rows in as an initialRows prop and hydrate from it (don't refetch on mount if initialRows is present). This is the same server-parent + paginated-client-child pattern already used by edition/[slug]/page.tsx with SalesTablePaginated (server fetches `initial`, client handles "load more").
- Keep the per-page layout.tsx metadata as-is (it's already good and server-rendered).

Priority order (do as separate commits so any one can revert independently): squeeze, rookies, deals, first-mint first (highest search demand + entity keys present), then set-squeeze, market, offer-spread, pinnacle-scarcity, cross-collection. SKIP pack-reality for now — its backing view has only 6 rows (data-coverage limited); leave it client-rendered or noindex it (Item C) until it has depth.

Note: squeeze-check and tc-report are wallet-input tools, not content boards — leave them client-rendered (correct as-is).

Revert: git revert the per-surface commit.

Verification: view-source https://www.rippackscity.com/insights/squeeze logged-out and confirm the ranked rows AND the /nba-top-shot/edition/... links are present in the raw HTML (not "Loading…"). npx tsc --noEmit clean; deploy READY; smoke passes.

---

ITEM B (P2) — Native /api/cron/refresh-cross-collection route (retire the interim Cowork task)

Why: the /insights/cross-collection backing tables (cross_collection_cohort_mat, cross_collection_ts_set_overlap_mat) have no native refresh cron — they were 5 days stale until Cowork refreshed them, and a Cowork scheduled task (rpc-cross-collection-refresh, daily ~6:40am) is currently the stopgap. The Cowork task only fires when the desktop app is open. A server-side cron makes it bulletproof and monitorable like the other 23 pipelines.

Change: add app/api/cron/refresh-cross-collection/route.ts mirroring the existing app/api/cron/refresh-pack-grail-metrics-mv/route.ts (same admin-auth pattern: POST, Authorization: Bearer INGEST_SECRET_TOKEN, also accept ?token= for browser-fired cron). Body: call supabaseAdmin.rpc("refresh_cross_collection_cohort_step1") then ...step2 (each returns a small JSON; step1 {cohort_size, computed_at}, step2 {set_overlap_rows, computed_at}), then log a pipeline_runs row (pipeline = "refresh-cross-collection", ok = both succeeded, extra = the two payloads). maxDuration 60. Then:
- Add a cron-job.org entry hitting https://www.rippackscity.com/api/cron/refresh-cross-collection daily (use www — the apex 308s), Authorization: Bearer $INGEST_SECRET_TOKEN.
- Optionally add "refresh-cross-collection" to pipeline_cadence_watchlist (@1500m/medium) so detect_stalled_pipelines() sees a stall.
- Disable/delete the interim Cowork scheduled task rpc-cross-collection-refresh (Scheduled sidebar) once this is live.

Revert: git revert the route commit; delete the cron-job.org entry; (re-enable the Cowork task if needed).

Verification: PowerShell Invoke-WebRequest POST to the route with the bearer token returns ok with advancing computed_at; pipeline_runs has the row; the live page's "Updated" timestamp moves.

---

ITEM C (P3 — small content-quality, fold in opportunistically)

C1. Edition meta-description series fragment. lib/seo.ts editionPageMetadata builds the description with a bare series label, so for series 7 it renders "Tier LEGENDARY. 7. Circulation 75." (verified live on /nba-top-shot/edition/187%3A6905). The "7." reads as a dangling fragment. Fix: render it as "Series {label}." and/or map the on-chain series number to its display name per the CLAUDE.md series map (7 = 2024-25, 8 = 2025-26, etc.). First confirm where series_label originates (get_edition_detail) — if it returns the raw number, format in seo.ts; if it should already be a name, fix the source. Affects every edition meta description, so it's a broad small win. Revert: git revert.

C2 (optional, low priority). The global collection nav and the overview "Tools" grid link auth-gated tabs (collection/sniper/sets/market/analytics) that 302->/login for anon crawlers. Cosmetic crawl-efficiency only — Google just drops them, no ranking harm to the good pages. Only worth touching when you're already in that chrome (gate those links behind auth state, or render as buttons for anon). Not a standalone deploy.

---

GUARDRAILS (every item)

- Direct to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Item A is the big one — do it as one-surface-per-commit so a single board can roll back without taking the others down. Run the smoke test after each.

END STATE

Item A: each insights board serves its ranked rows + entity drill-down links in the raw server HTML (view-source, not just post-JS) — the unique content becomes rankable and the crawl equity actually flows into the entity corpus. Item B: cross-collection refresh runs server-side daily, monitored, Cowork stopgap retired. Item C: cleaner edition meta descriptions. Net: the surfaces the internal-linking pass now points at become first-class, server-rendered, rankable destinations.
