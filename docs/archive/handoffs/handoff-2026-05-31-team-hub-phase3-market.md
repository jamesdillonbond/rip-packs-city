# Team Hub — Phase 3 handoff (market activity / sets / squeeze / rookies)

Date: 2026-05-31. Scope: NBA Top Shot first. Full spec: docs/features/team-hub-buildout-2026-05-31.md. Adds the "everything about this team" depth below the checklist.

CONTEXT
Phase 1 shipped (0f65db8): branded hero + 30d stats + roster toggle. Phase 2 shipped (dcb23eb): Team Checklist (All-Time / Contemporary / by-Series + cost-to-complete + wallet-paste ownership). This Phase 3 adds four read-only sections beneath Top Editions: Market Activity, Sets featuring the team, Squeeze & scarcity, and a Rookie indicator. New DB: three new read RPCs + one optional small helper (Cowork can apply live). New code: routes + components, wired into the team page. Rebase on latest main.

VERIFIED FOR THIS HANDOFF (prod DB, 2026-05-31)
- sales -> editions join by edition_id is the team-activity source (Lakers: 1,599 sales / 30d). route_slug = COALESCE(e.external_id, e.id::text); set_slug = regexp_replace(lower(set_name),'[^a-z0-9]+','-','g') — both confirmed against the live get_team_top_editions body. Clone that projection.
- topshot_squeeze_board columns: edition_id, external_id, player_name, set_name, tier, circulation, locked, burned, lock_pct, burn_pct, squeeze_pct, effectively_buyable, low_ask, fmv_usd, confidence, game_date, thumbnail_url. NO team column -> join on edition_id = editions.id and filter team_name. TS-only view (985 rows) -> the squeeze section is NBA-Top-Shot-only; return empty for other collections.
- Rookie overlap is SPARSE: only 1 of 61 topshot_2025_rookie_players maps to the Lakers (~1-2/team). Do NOT build a standalone rookie section — surface it as a "Rookie" chip on the existing roster instead (D8/C optional).

DB HALF — new SECURITY DEFINER functions. Each migration MUST end with: REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION public.<fn>(...) TO service_role; (matches the existing entity RPCs; routes call via service-role supabaseAdmin). Cowork can apply all live via apply_migration on request. Resolve team variants the same way every team RPC does: SELECT array_agg(DISTINCT team_name) FROM editions WHERE collection_id=p_collection_id AND team_name IS NOT NULL AND regexp_replace(lower(trim(team_name)),'[^a-z0-9]+','-','g')=p_team_slug; return '[]'::jsonb when null.

D5 — get_team_activity(p_collection_id uuid, p_team_slug text, p_limit int DEFAULT 30, p_offset int DEFAULT 0) RETURNS jsonb. Recent team sales.
  Body: resolve variants. Then:
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)),'[]') FROM (
      SELECT COALESCE(e.external_id, e.id::text) AS route_slug, e.player_name, e.set_name, e.tier::text AS tier,
             e.thumbnail_url, s.serial_number, s.price_usd, s.sold_at, s.marketplace
      FROM sales s JOIN editions e ON e.id = s.edition_id
      WHERE e.collection_id = p_collection_id AND e.team_name = ANY(v_variants)
      ORDER BY s.sold_at DESC
      LIMIT LEAST(GREATEST(COALESCE(p_limit,30),1),100) OFFSET GREATEST(COALESCE(p_offset,0),0)
    ) t;
  (sales is year-partitioned; the parent table query is fine and bounded by the team's editions. 8s statement_timeout; if a huge team risks it, add AND s.sold_at >= now() - interval '180 days'.)
  Revert: DROP FUNCTION public.get_team_activity(uuid,text,integer,integer);
  Verify: get_team_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd','los-angeles-lakers',5,0) returns recent Lakers sales (LeBron / Reaves / Hachimura) with price + sold_at + marketplace.

D6 — get_team_sets(p_collection_id uuid, p_team_slug text, p_wallet text DEFAULT NULL) RETURNS jsonb. Sets featuring the team, with completion + cheapest entry.
  Body: resolve variants. Group the team's renderable editions by set:
    WITH te AS (
      SELECT e.id, e.external_id, e.set_name,
             regexp_replace(lower(e.set_name),'[^a-z0-9]+','-','g') AS set_slug, e.series,
             fmv.fmv_usd, fmv.floor_price_usd
      FROM editions e
      LEFT JOIN LATERAL (SELECT fmv_usd, floor_price_usd FROM fmv_snapshots WHERE edition_id=e.id ORDER BY computed_at DESC LIMIT 1) fmv ON true
      WHERE e.collection_id=p_collection_id AND e.team_name=ANY(v_variants) AND e.set_name IS NOT NULL AND e.thumbnail_url IS NOT NULL
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY g.editions DESC),'[]') FROM (
      SELECT te.set_slug, MIN(te.set_name) AS set_name, COUNT(*) AS editions,
             MIN(COALESCE(te.floor_price_usd, te.fmv_usd)) FILTER (WHERE COALESCE(te.floor_price_usd,te.fmv_usd)>0) AS cheapest_entry_usd,
             CASE WHEN p_wallet IS NULL THEN NULL ELSE COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address=p_wallet AND w.collection_id=p_collection_id AND w.edition_key=te.external_id)) END AS owned
      FROM te GROUP BY te.set_slug
    ) g;
  KNOWN NUANCE: slugify(set_name) collapses same-named sets across series (e.g. "Base Set" S5 + S8 -> one "base-set" row). That matches how the set page is keyed today; acceptable for v1. If per-series set rows are wanted later, group by (set_slug, series).
  Revert: DROP FUNCTION public.get_team_sets(uuid,text,text);
  Verify: get_team_sets('95f...','los-angeles-lakers',NULL) returns sets like 2020 NBA Finals / Holo Icon / Base Set with editions counts + cheapest_entry_usd; with a cached wallet, owned populates.

D7 — get_team_squeeze(p_collection_id uuid, p_team_slug text, p_limit int DEFAULT 12) RETURNS jsonb. Team slice of the squeeze board (NBA Top Shot only).
  Body: if p_collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd' RETURN '[]'::jsonb; (the board is TS-only). Resolve variants. Then:
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)),'[]') FROM (
      SELECT COALESCE(e.external_id, e.id::text) AS route_slug, sb.player_name, sb.set_name, sb.tier,
             sb.squeeze_pct, sb.lock_pct, sb.burn_pct, sb.effectively_buyable, sb.circulation,
             sb.low_ask, sb.fmv_usd, sb.thumbnail_url
      FROM topshot_squeeze_board sb
      JOIN editions e ON e.id = sb.edition_id
      WHERE e.collection_id = p_collection_id AND e.team_name = ANY(v_variants)
      ORDER BY sb.squeeze_pct DESC NULLS LAST
      LIMIT LEAST(GREATEST(COALESCE(p_limit,12),1),50)
    ) t;
  Revert: DROP FUNCTION public.get_team_squeeze(uuid,text,integer);
  Verify: get_team_squeeze('95f...','los-angeles-lakers',5) returns the team's highest-squeeze editions (squeeze_pct desc) with effectively_buyable + low_ask.

D8 (OPTIONAL, light) — rookie indicator on the roster. Rather than a section, extend get_team_players (Phase 1 already returns is_active) to also return is_rookie: in the with_meta select, add a flag is_rookie := EXISTS (SELECT 1 FROM topshot_2025_rookie_players r WHERE regexp_replace(lower(trim(r.player_name)),'[^a-z0-9]+','-','g') = a.player_slug). Same signature -> grants preserved. Pinnacle branch: is_rookie = false. Revert: CREATE OR REPLACE prior body. (If you'd rather not touch get_team_players again, skip D8 and drop the rookie chip from C9 — it's the lowest-value item here.)

CODE HALF — Claude Code. Full-file writes, LF, tsc clean. Verify paths before creating.

C7 — Routes. Create three routes mirroring app/api/entity/team-editions/route.ts exactly (param clamping + error handling): app/api/entity/team-activity/route.ts (-> get_team_activity), app/api/entity/team-sets/route.ts (-> get_team_sets, pass optional wallet), app/api/entity/team-squeeze/route.ts (-> get_team_squeeze). All read-only; proxy.ts already opens GET /api/entity/* to anon.

C8 — Components (server components are fine; data is fetched server-side in page.tsx and passed in, OR each is a small client island that fetches on mount — match the existing pattern; the Phase 1/2 sections fetch server-side in page.tsx, so prefer that). Create:
  - components/entity/TeamActivity.tsx — a compact recent-sales table (Moment -> /<collection>/edition/<route_slug>, serial, price, relative time, marketplace) + a "Biggest sales (30d)" subhead derived by sorting the same rows by price (or a second fetch with a higher limit). Reuse _shared fmtUsd/relTime.
  - components/entity/TeamSets.tsx — a table/cards of sets: set name -> /<collection>/set/<set_slug>, # team editions, cheapest entry, and "You own X" when a wallet is active (reuse the wallet from the checklist's localStorage key so it stays in sync).
  - components/entity/TeamSqueeze.tsx — a ranked table: edition -> route_slug, squeeze_pct (accent), effectively_buyable / circulation, low_ask. Only render the section when the array is non-empty (so it self-hides for non-TS collections).
  - Brand tokens only (var(--rpc-*)); no hardcoded #E03A2F / 'Barlow Condensed'.

C9 — Wire into app/(collections)/[collection]/team/[slug]/page.tsx. Fetch the three RPCs in the existing Promise.all (alongside players + topEditions), and render <Section> blocks in this order BELOW the existing Top Editions section: Market Activity, Sets featuring <team>, Squeeze & Scarcity. Keep hero / stat strip / checklist / Top Editions / roster as-is. If D8 shipped, add a small "Rookie" chip to the roster tile in PlayersGridPaginated when is_rookie is true (no new section).
  Revert: git revert <commit> (removes components + routes + wiring).

GUARDRAILS (repeat every handoff)
- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git (Git Bash git commit can silently no-op). Re-verify: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST -> PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration cap 800s (not relevant here).
- CRLF: full-file writes, no string-replace patching.
- After deploy: smoke + Vercel READY; npx tsc --noEmit clean.

LET CLAUDE CODE CORRECT FALSE PREMISES
Claude Code's direct file inspection wins over this doc and project_knowledge_search on any disagreement — adapt to the actual file shape. Clone the REAL get_team_top_editions projection for route_slug/set_slug; locate the page.tsx Promise.all + section order by surrounding markup, not line numbers; if the squeeze board's edition_id join is cheaper via external_id, either is fine (board is TS-only so external_id is unique there).

END STATE
One commit on main, tsc clean, Vercel READY, and the Lakers team page shows, below Top Editions: a Market Activity table (recent sales + biggest 30d), a Sets-featuring-the-Lakers list (counts + cheapest entry + owned when tracking), and a Squeeze & Scarcity ranking. Squeeze self-hides on non-TS collections. Optional rookie chip on the roster. Phase 4 (follow-team / live-game / alerts) is the last increment.
