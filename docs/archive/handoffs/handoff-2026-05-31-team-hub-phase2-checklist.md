# Team Hub — Phase 2 handoff (Team Checklist + cost-to-complete)

Date: 2026-05-31. Scope: NBA Top Shot first. Full spec: docs/features/team-hub-buildout-2026-05-31.md. This is the differentiated centerpiece — the public, priced team checklist Top Shot keeps behind login.

CONTEXT
Phase 1 shipped (commit 0f65db8, deploy READY): branded TeamHero + TeamLogo island, get_team_detail v2 (teams_master branding + 30d sales/volume), get_team_players surfacing is_active, 30d stat cells, Current/All-Time roster toggle. This Phase 2 adds the Team Checklist: three scopes (All-Time / Contemporary / per-Series), owned-vs-missing tracking from a pasted wallet, and a cost-to-complete number. New DB: two read-only functions (Cowork can ship via apply_migration on request). New code: one component + one or two routes, wired into the team page. Rebase on latest main before starting (Phase 1 HEAD was 0f65db8).

DECISIONS (resolved with Trevor — do not re-litigate)
- Ownership tracking = WALLET-PASTE, no login. The checklist computes owned/missing from wallet_moments_cache for a pasted 0x Flow address. This is public on-chain catalog data, read-only, no auth, no PII. It reuses the wallet-paste onboarding path already handed off (docs/handoff-2026-05-31-wallet-paste-onboarding.md): if the pasted wallet is not already cached in wmc, fire the existing wallet-backfill (fire-and-forget) and show an "indexing your collection..." pending state, then re-query. Login-based "Follow team" is Phase 4. Rationale: keeps the checklist a useful PUBLIC, indexable SEO page (full checklist + public cost-to-complete visible to anonymous visitors) and matches the activation strategy.
- Contemporary definition (Trevor, verified in data 2026-05-31): a moment is Contemporary when the season of its play (game_date) equals the season of the series it was minted in. Throwback / historical sets that mint old plays into a current series are excluded. Verified the test isolates exactly those sets: Archive Set (112 rows, games 2013-2019), Run It Back: Origins (94, back to 1985), Vintage Vibes (79), Run It Back (62), Heroes of the Game (games to 1958), Supernova (28), Run It Back: 1970s, etc. game_date coverage is high for recent series (Series 7 ~99.6%, Series 8 ~92.6%, Series 6 ~95%); ~5-8% of recent editions have null game_date and are conservatively EXCLUDED from Contemporary (better to drop a few legit ones than admit a throwback). series=null rows (the ~1.8K inert UUID stubs) carry no game_date and are already dropped by the thumbnail_url filter.

DB HALF — two NEW functions. New SECURITY DEFINER functions get default PUBLIC EXECUTE, so each migration MUST end with: REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION public.<fn>(...) TO service_role; (matches every other entity RPC — the route calls via the service-role supabaseAdmin client). Cowork can apply both live via apply_migration on request.

D3 — get_team_checklist(p_collection_id uuid, p_team_slug text, p_scope text DEFAULT 'all_time', p_wallet text DEFAULT NULL, p_limit int DEFAULT 60, p_offset int DEFAULT 0) RETURNS jsonb.
Build it by CLONING the body of the existing get_team_top_editions so the per-edition projection (route_slug, thumbnail_url, tier, fmv_usd, confidence, set_name, player_name, etc.) matches the live tiles exactly. Pull the real body first: SELECT pg_get_functiondef('public.get_team_top_editions(uuid,text,integer,integer)'::regprocedure); Then add exactly three things:
  1. Scope filter. Compute per edition, in the base CTE:
     series_season := CASE e.series WHEN 0 THEN 2019 WHEN 1 THEN 2019 WHEN 2 THEN 2020 WHEN 3 THEN 2021 WHEN 4 THEN 2021 WHEN 5 THEN 2022 WHEN 6 THEN 2023 WHEN 7 THEN 2024 WHEN 8 THEN 2025 END
     play_season  := CASE WHEN e.game_date IS NULL THEN NULL WHEN EXTRACT(month FROM e.game_date) >= 8 THEN EXTRACT(year FROM e.game_date)::int ELSE EXTRACT(year FROM e.game_date)::int - 1 END
     Apply: when p_scope = 'contemporary' keep rows where play_season IS NOT NULL AND play_season = series_season; when p_scope LIKE 'series_%' keep rows where e.series = substring(p_scope from 8)::int; otherwise (all_time) no extra filter. KEEP the existing thumbnail_url IS NOT NULL filter from get_team_top_editions (it drops the series=null UUID stubs).
     (The series->season map mirrors CLAUDE.md "Series map". If a canonical series table is preferred later, swap the CASE for a join; the CASE is correct today.)
  2. Ownership. When p_wallet IS NOT NULL, LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM wallet_moments_cache w WHERE w.wallet_address = p_wallet AND w.collection_id = p_collection_id AND w.edition_key = e.external_id) own ON true. Expose owned := CASE WHEN p_wallet IS NULL THEN NULL ELSE (own.cnt > 0) END and owned_count := own.cnt. (wmc.edition_key = editions.external_id is the documented contract; do NOT join on editions.id.) NOTE: there is NO per-wallet "locked" flag in wmc, so v1 is owned-vs-missing only (no green/white/gray "locked" distinction — that needs a lock-state source we do not ingest per wallet yet; leave a code comment and revisit).
  3. Ordering. When p_wallet IS NOT NULL: ORDER BY owned ASC NULLS FIRST, fmv_usd DESC NULLS LAST (missing + valuable first). Else: ORDER BY fmv_usd DESC NULLS LAST. Clamp v_limit to 1..200, v_offset >= 0.
Revert: DROP FUNCTION public.get_team_checklist(uuid,text,text,text,integer,integer);
Verify: SELECT get_team_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd','los-angeles-lakers','contemporary',NULL,5,0) returns only contemporary Lakers editions (NO Archive / Run It Back / Vintage Vibes rows). With a cached wallet (e.g. 0xbd94cade097e50ac) the owned flags populate; with an uncached wallet they come back null/0 (the route handles the backfill trigger).

D4 — get_team_checklist_progress(p_collection_id uuid, p_team_slug text, p_scope text DEFAULT 'all_time', p_wallet text DEFAULT NULL) RETURNS jsonb.
Reuse the EXACT same team-variant resolution + base/scoped CTEs from D3 (minus pagination), with the same fmv LATERAL (need fmv_usd, floor_price_usd, confidence) and the same ownership LATERAL. Return jsonb_build_object of:
  total                 = COUNT(*)
  owned                 = COUNT(*) FILTER (WHERE owned IS TRUE)            (0 when p_wallet null)
  missing_count         = total - owned
  completion_pct        = round(100.0 * owned / NULLIF(total,0), 1)
  cost_to_complete_usd  = SUM(COALESCE(floor_price_usd, fmv_usd)) FILTER (WHERE owned IS NOT TRUE)   (floor preferred; when p_wallet null this is the full-checklist acquisition cost — the public number)
  stale_missing_pct     = round(100.0 * COUNT(*) FILTER (WHERE owned IS NOT TRUE AND confidence IN ('STALE','LOW','NO_DATA')) / NULLIF(missing_count,0), 0)
  by_tier               = jsonb_agg of { tier, total, owned, cost_usd } grouped by tier
Revert: DROP FUNCTION public.get_team_checklist_progress(uuid,text,text,text);
Verify: progress('...','los-angeles-lakers','all_time',NULL) -> total ~ renderable Lakers editions, cost_to_complete_usd in the low thousands, stale_missing_pct present; 'contemporary' total < all_time total.

CODE HALF — Claude Code. Full-file writes, LF, tsc clean. Verify each path before creating.

C4 — Routes. Create app/api/entity/team-checklist/route.ts by mirroring app/api/entity/team-editions/route.ts EXACTLY (same offset/limit clamping and error handling). Accept query params: collection, slug, scope (all_time | contemporary | series_<n>), wallet (optional), offset, limit; call get_team_checklist with them. Create a sibling app/api/entity/team-checklist-progress/route.ts that calls get_team_checklist_progress (collection, slug, scope, wallet). Both are read-only catalog reads; proxy.ts already opens GET /api/entity/* to anon, so no auth wiring needed.

C5 — TeamChecklist component. Create components/entity/TeamChecklist.tsx (client; verify it does not exist). Props: collectionUrlSlug, teamSlug, seriesOptions?: number[]. Behaviour:
  - Three scope tabs: All-Time, Contemporary, and a By-Series chip row (one chip per entry in seriesOptions, labelled via the CLAUDE.md series map -> "2025-26" etc.). Changing scope refetches both the checklist (paginated) and progress routes for that scope.
  - Progress header from the progress route: a completion bar (owned/total), "Owned X / Y", the cost-to-complete dollar figure, and a small per-tier breakdown (Common/Rare/Legendary/Ultimate owned + cost). When no wallet is set, label the cost as "Cost to complete at floor" (the public full-checklist number) and show a stale-pricing honesty note when stale_missing_pct is non-trivial (e.g. "X% of missing have stale pricing").
  - Wallet-paste: a text input for a 0x Flow address + "Track" button. On submit, pass wallet to both routes. If the wallet is not yet indexed (owned all null/0 AND a not-cached signal), show "Indexing your collection - check back shortly" and trigger the EXISTING wallet-backfill via the wallet-paste onboarding util (docs/handoff-2026-05-31-wallet-paste-onboarding.md) - do NOT re-implement backfill. Persist the pasted wallet in localStorage so it carries across team pages (this is the real app - localStorage is fine here; that restriction is only for sandboxed artifacts).
  - Tiles: reuse the EditionsGridPaginated tile styling. Add an ownership badge per tile: owned -> solid check; missing -> "+ $<floor> to add". (No locked/green state in v1 - see D3 note.) Lazy-load thumbnails as the existing grid does.
  - Anonymous state (no wallet): render the FULL checklist + the public cost-to-complete, with CTA "Paste your wallet to see what you're missing." This is the indexable SEO surface - it must render fully without a wallet.
  - Brand tokens only (var(--rpc-*), var(--font-display)); never hardcode #E03A2F or 'Barlow Condensed'.

C6 — Wire into the team page. In app/(collections)/[collection]/team/[slug]/page.tsx, insert <TeamChecklist collectionUrlSlug={collection} teamSlug={slug} seriesOptions={...} /> as a new <Section title="Team Checklist"> placed BETWEEN the stat strip and the "Top Editions" Section (it is the headline feature). For seriesOptions: simplest v1 is to let TeamChecklist derive available series from its first all_time fetch (group the returned rows by series) and render the chip row from that, so page.tsx passes nothing. If you prefer server-side, add a series list to get_team_detail in a tiny follow-up. Do not disturb the Phase 1 hero/stat-strip/roster work.
Revert: git revert <commit> (removes the component, routes, and the page wiring).

GUARDRAILS (repeat every handoff)
- Direct-to-main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST - use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s. (Not relevant here.)
- CRLF: don't string-replace-patch on Windows; full-file writes or findIndex on split lines.
- After deploy: smoke test + confirm the Vercel deploy reaches READY; npx tsc --noEmit clean.

LET CLAUDE CODE CORRECT FALSE PREMISES
Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement - adapt to the actual file shape. In particular: clone the REAL get_team_top_editions body for D3 rather than trusting any projection sketched here; locate the page.tsx insertion point by surrounding markup, not line number; and if get_team_top_editions already exposes series/game_date in a way that makes the scope filter cleaner, use it.

END STATE
One commit on main, npx tsc --noEmit clean, Vercel READY, and the Lakers team page shows a Team Checklist above Top Editions with three scopes (All-Time / Contemporary / by-Series), a public cost-to-complete figure, and wallet-paste owned-vs-missing tracking. The Contemporary tab excludes Archive / Run It Back / Vintage Vibes / Heroes of the Game. Anonymous visitors see the full checklist (SEO). Phases 3 (activity / sets / squeeze / rookies) and 4 (follow-team / live-game / alerts) follow in later handoffs.
