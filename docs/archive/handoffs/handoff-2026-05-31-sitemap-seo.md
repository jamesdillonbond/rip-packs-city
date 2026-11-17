HANDOFF — Sitemap is missing ALL entity pages (the real SEO discovery blocker) + readiness findings
Date 2026-05-31. Topic: app/sitemap.ts, app/robots.ts. Found during the post-launch SEO indexing-readiness pass on the now-public entity pages.

CONTEXT
The entity detail pages (edition/set/player/team/series/pack) now render for anon, have correct canonical + JSON-LD, and robots.txt allows them. BUT the live sitemap.xml contains ZERO entity URLs — so Google has no sitemap-based discovery path for any of the ~20.5K pages. Verified live (anon fetch of https://www.rippackscity.com/sitemap.xml): 258 <url> entries total, 0 matching /edition/ /set/ /player/ /team/ /series/ /pack/. (Correction to the 2026-05-30 entity-pages docs: those said "the sitemap advertises ~16K edition URLs that 404." That was inferred from reading sitemap.ts, not the live file. Reality: the live sitemap omits entity URLs entirely. The decode fix was still correct — pages 404'd for users clicking grid links.) This is code (Cowork can't deploy), so it's a handoff. Mount HEAD when written: 959ec85 (note: the mount appears behind your entity commits bf3f4f6/b106a27/5797235/29d2e46 — re-verify against your real origin/main; your direct file inspection wins over this doc).

WHAT'S ALREADY GOOD (verified live, no action needed)
- Edition page canonical = https://www.rippackscity.com/nba-top-shot/edition/245%3A8424 (correct), meta robots = "index, follow" (indexable). Pinnacle colon+space slugs and AllDay integer slugs render too.
- robots.txt allows all entity paths for Googlebot; disallows /api/ /_next/ /admin/ /login /dashboard /auth/ /share/ /panini-blockchain/ + user-scoped query params. AI-training crawlers (GPTBot/ClaudeBot/etc.) blocked by design.
- RPC-derived sitemap entries DO populate (/analytics/sets = 101, /analytics/wallets = 71), so runtime DB access at generation works.

GUARDRAILS (repeat)
- Direct to main, no branches/PRs. Commit via PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0). curl fails silently in Git Bash — use PowerShell Invoke-WebRequest. Vercel Pro maxDuration cap 800s. No CRLF string-replace patches — full-file writes.
- Your direct file inspection wins over this doc and project_knowledge_search on any disagreement.

=====================================================================
ITEM 1 — P0 — Get entity URLs into the sitemap (robust rewrite)
=====================================================================
FILE: app/sitemap.ts
SYMPTOM: editionPages, newSetPages, newPlayerPages, newTeamPages (all derived from getEditionRows) and seriesPages (from getCollectionSeries) produce 0 live URLs. The two functions are the ONLY sitemap sources that use a PostgREST embedded-resource join + embedded filter:
  .from('editions').select('id, external_id, last_updated_at, player_name, set_name, team_name, collections!inner(slug)').in('collections.slug', EDITION_COLLECTION_DB_SLUGS)...
The FK editions_collection_id_fkey EXISTS and the data exists (nba_top_shot 16,278 / nfl_all_day 6,191 / laliga_golazos 581 / ufc_strike 446 = ~23.5K rows, join is instant), yet these return []. getTopSets + getLoanWallets (plain .rpc() calls, no embed) populate fine. So the embedded-join/embedded-filter path is what's failing at generation (or returning empty). collection_series likewise has collection_id.
STEP 0 (diagnose, optional): check Vercel runtime logs (production, short window) for "[sitemap] editions query error" / "[sitemap] editions query threw" — those are the catch-logged lines in getEditionRows. Also force a fresh regen (redeploy, or wait past the revalidate=21600 6h cache) to rule out a stale cache from before the entity code deployed.
FIX (definitive, regardless of sub-cause): drop the embedded join; filter by collection_id directly against the known UUIDs and map the slug locally. editions and collection_series both have collection_id. Replace the getEditionRows query body with:
  const COLLECTION_ID_TO_DB_SLUG: Record<string,string> = {
    '95f28a17-224a-4025-96ad-adf8a4c63bfd':'nba_top_shot',
    'dee28451-5d62-409e-a1ad-a83f763ac070':'nfl_all_day',
    '06248cc4-b85f-47cd-af67-1855d14acd75':'laliga_golazos',
    '9b4824a8-736d-4a96-b450-8dcc0c46b023':'ufc_strike',
  }
  const { data, error } = await sb
    .from('editions')
    .select('id, external_id, last_updated_at, player_name, set_name, team_name, collection_id')
    .in('collection_id', Object.keys(COLLECTION_ID_TO_DB_SLUG))
    .order('last_updated_at', { ascending: false, nullsFirst: false })
    .limit(50000)
  // then map: collection_db_slug: COLLECTION_ID_TO_DB_SLUG[r.collection_id] ?? ''
Do the same for getCollectionSeries (collection_series → .select('display_label, updated_at, collection_id').in('collection_id', Object.keys(COLLECTION_ID_TO_DB_SLUG)) ; map slug locally). Keep everything downstream (slug derivation, dedupe, entityPages()) identical — collection_db_slug is still produced, just sourced from the UUID map instead of the embed.
ALSO: the head-comment block (lines ~1-18) still lists per-set/per-player pages as "Deferred — routes that don't exist yet." Stale — update it to reflect that entity pages are enumerated.
REVERT: git revert the commit.
VERIFY: after deploy + a sitemap regen, fetch /sitemap.xml and confirm /edition/ /set/ /player/ /team/ /series/ counts are non-zero (expect ~23K editions + a few hundred sets/players/teams + series). Confirm total stays under Google's 50K-URLs / 50MB per-sitemap limit; if editions alone approach 50K later, split into a sitemap index (one child per collection or per entity type).

=====================================================================
ITEM 2 — P1 — Pack pages are not in the sitemap at all
=====================================================================
FILE: app/sitemap.ts
WHY: pack distribution pages (/<collection>/pack/dist/<distId>) render with covers + EV + (now) JSON-LD, and the file's header comment claims "per-pack pages (5,149 rows in pack_distributions)", but there is NO packPages array and it is NOT in the return [] assembly (grep: 0 hits for packPages). So 5,149 pack pages have no sitemap discovery path.
FIX: add a getPackRows() (query pack_distributions: select dist_id, collection_id, updated_at; .in('collection_id', the 5 published UUIDs incl. Pinnacle 7dd9dd11-…; .limit(10000)), map to /<urlSlug>/pack/dist/<encodeURIComponent(dist_id)>, priority ~0.5, changeFrequency weekly), and spread ...packPages into the return array. Use getCollectionByDbSlug / the collections registry for the urlSlug mapping (the file already imports it).
REVERT: git revert.
VERIFY: /sitemap.xml shows /pack/dist/ URLs; spot-load one (e.g. /nba-top-shot/pack/dist/1681) → renders.

=====================================================================
ITEM 3 — P2 — robots.txt likely blocks public profile pages
=====================================================================
FILE: app/robots.ts
WHY: disallow list includes '/profile' (line ~30). robots.txt Disallow is a PREFIX match, so '/profile' blocks '/profile/<username>' (the public profile pages) too — contradicting the inline comment ("/profile/* (public profiles) NOT disallowed"). The explicit '/profile/edit' + '/profile/settings' entries are then redundant.
FIX: remove the bare '/profile' entry (keep '/profile/edit' and '/profile/settings'); the legacy '/profile' editor route 308s to /dashboard which is already disallowed, so the bare entry isn't protecting anything that needs it. If you want to be strict about the legacy exact path, use a more specific rule, but do NOT prefix-block all profiles.
REVERT: git revert.
VERIFY: robots.txt no longer contains a bare "Disallow: /profile"; /profile/<username> is crawlable.

=====================================================================
ITEM 4 — Google Search Console (operator, AFTER Items 1-2 deploy)
=====================================================================
These are inert until the sitemap actually contains entity URLs — do them after Item 1 ships and /sitemap.xml shows entity pages. I cannot drive your Google account; steps for you:
- Search Console → Sitemaps → (re)submit https://www.rippackscity.com/sitemap.xml. Confirm "Discovered URLs" jumps from ~258 to ~24K.
- URL Inspection on 3-5 high-value editions (e.g. the Wembanyama 245:8424, a top LeBron edition) → "Request indexing" to seed crawl.
- Pages report → watch "Crawled - currently not indexed" / "Discovered - not indexed" over the next 1-2 weeks; entity pages should migrate to Indexed.
- If you previously submitted a sitemap and saw 404s logged, those were users/crawlers hitting colon slugs pre-decode-fix; they now 200, so coverage errors should clear on re-crawl.

EXPECTED END STATE
Items 1-2 on main + deploy READY + sitemap regenerated → /sitemap.xml contains ~24K entity + 5K pack URLs (was 258); Item 3 → profiles crawlable; then the Search Console resubmit converts the now-reachable, indexable, structured-data pages into actual crawl + index coverage. This is the step that turns the entire entity-pages SEO build into traffic.
