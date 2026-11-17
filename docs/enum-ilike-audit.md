# Audit — `.ilike()` calls against Postgres enum columns (2026-05-03)

## Background

Postgres enum columns + supabase-js `.ilike()` is a silent footgun. PostgREST emits the query without a text cast, the operator does not exist for the enum type, and **the filter drops to no-results rather than erroring**. The user-facing symptom is "the tool returned no data" when in fact the data exists and the filter just ate it.

Discovered via the concierge tier-filter incident on 2026-05-03 (Test 2 sixth run, see `docs/concierge-tests-2026-05-03.md` § "Sixth run"). Fix landed in commits:

- **`f55e022`** — system-prompt rule mandating tier filtering on FMV tools
- **`e9c90e5`** — replaces `.ilike("tier", \`%${input.tier}%\`)` with `.eq("tier", input.tier.toUpperCase())` in [lib/concierge/fmv-distribution.ts](../lib/concierge/fmv-distribution.ts)

This audit grepped the entire repo for `.ilike()` (and the two alternative paths PostgREST exposes: `.filter(col, "ilike", ...)` and `.or("col.ilike.value")` pattern strings) to see whether the same footgun lurks elsewhere.

## Result

**No active exposures found.** Every `.ilike()` call in the repo targets a `text` column (verified against `information_schema.columns` on 2026-05-03). The previous exposure (the `fmv-distribution.ts` tier filter) was already fixed in `e9c90e5` before this audit ran.

No corrective commits required from this audit. Closing the issue.

## Method

1. Grep `\.ilike\(` across the repo → 25 code-side hits (plus 5 doc-side references in `concierge-tests-2026-05-03.md` which are descriptive, not exposures).
2. Grep alternative paths: `\.filter\([^)]*['"]ilike['"]` and `\.or\([^)]*ilike\.|ilike\.[^,)]+` → 2 additional hits.
3. For each hit, identify the target table from the surrounding `.from()` context.
4. Cross-reference `(table, column)` against the directive's 11-enum list:
   - `editions.edition_kind`
   - `editions.tier`
   - `sets.tier`
   - `players.player_tier`
   - `collections.chain`
   - `fmv_current.confidence`
   - `fmv_snapshots.confidence` (plus year-partitioned variants `fmv_snapshots_2025/2026/2027.confidence`)
   - `pinnacle_fmv_snapshots.confidence`
5. For columns not in the 11-enum list but worth confirming (e.g. `pinnacle_editions.variant_type`, `editions.player_name`), query `information_schema.columns` directly to verify `data_type` is `text`, not `USER-DEFINED`.

## Universe of `.ilike()` calls examined

All 27 hits (25 from `.ilike(` grep + 2 from alternative-path grep), with their target table and column, the column's actual Postgres type, and verdict:

| File:line | Table.column | Type | Verdict |
|---|---|---|---|
| [lib/concierge/pinnacle-router.ts:116](../lib/concierge/pinnacle-router.ts#L116) | `pinnacle_cached_listings.character_name` | text | safe |
| [lib/concierge/pinnacle-router.ts:117](../lib/concierge/pinnacle-router.ts#L117) | `pinnacle_cached_listings.variant_type` | text | safe |
| [lib/concierge/pinnacle-router.ts:226](../lib/concierge/pinnacle-router.ts#L226) | `pinnacle_editions.character_name` | text | safe |
| [lib/concierge/pinnacle-router.ts:341](../lib/concierge/pinnacle-router.ts#L341) | `pinnacle_cached_listings.character_name` | text | safe |
| [lib/concierge/fmv-distribution.ts:202](../lib/concierge/fmv-distribution.ts#L202) | `editions.player_name` | text | safe |
| [lib/concierge/fmv-distribution.ts:203](../lib/concierge/fmv-distribution.ts#L203) | `editions.set_name` | text | safe |
| [lib/concierge/fmv-distribution.ts:324](../lib/concierge/fmv-distribution.ts#L324) | `pinnacle_editions.character_name` | text | safe |
| [lib/concierge/fmv-distribution.ts:325](../lib/concierge/fmv-distribution.ts#L325) | `pinnacle_editions.set_name` | text | safe |
| [lib/concierge/fmv-distribution.ts:326](../lib/concierge/fmv-distribution.ts#L326) | `pinnacle_editions.variant_type` | text | safe |
| [app/api/badges/route.ts:104](../app/api/badges/route.ts#L104) | `badge_editions.player_name` | text | safe |
| [app/api/badges/route.ts:105](../app/api/badges/route.ts#L105) | `badge_editions.player_name` | text | safe |
| [app/api/badges/route.ts:114](../app/api/badges/route.ts#L114) (OR-pattern `player_name.ilike.…`) | `badge_editions.player_name` | text | safe |
| [app/api/edition-search/route.ts:18](../app/api/edition-search/route.ts#L18) | `editions.player_name` | text | safe |
| [app/api/market/route.ts:139](../app/api/market/route.ts#L139) | `cached_listings.player_name` | text | safe |
| [app/api/market/route.ts:143](../app/api/market/route.ts#L143) | `cached_listings.raw_data->>parallel` | jsonb path → text | safe |
| [app/api/market-feed/route.ts:66](../app/api/market-feed/route.ts#L66) (`.filter("external_id","ilike",…)`) | `editions.external_id` | varchar | safe |
| [app/api/packs/route.ts:62](../app/api/packs/route.ts#L62) | `pack_table_rows.title` | text | safe |
| [app/api/seeded-wallets/route.ts:18](../app/api/seeded-wallets/route.ts#L18) | `seeded_wallets.username` | text | safe |
| [app/api/sniper-feed/route.ts:1494](../app/api/sniper-feed/route.ts#L1494) | `cached_listings.tier` | **text** | safe ⚠️ |
| [app/api/sniper-feed/route.ts:1497](../app/api/sniper-feed/route.ts#L1497) | `cached_listings.team_name` | text | safe |
| [app/api/support-chat/route.ts:673](../app/api/support-chat/route.ts#L673) | `cached_listings.player_name` | text | safe |
| [app/api/support-chat/route.ts:674](../app/api/support-chat/route.ts#L674) | `cached_listings.tier` | **text** | safe ⚠️ |
| [app/api/support-chat/route.ts:723](../app/api/support-chat/route.ts#L723) | `cached_listings.player_name` | text | safe |
| [app/api/support-chat/route.ts:724](../app/api/support-chat/route.ts#L724) | `cached_listings.team_name` | text | safe |
| [app/api/support-chat/route.ts:725](../app/api/support-chat/route.ts#L725) | `cached_listings.tier` | **text** | safe ⚠️ |
| [app/api/support-chat/route.ts:880](../app/api/support-chat/route.ts#L880) | `cached_listings.player_name` | text | safe |
| [app/api/public/profile/[username]/route.ts:29](../app/api/public/profile/[username]/route.ts#L29) | `profile_bio.username` | text | safe |
| [app/api/profile/follows/route.ts:16](../app/api/profile/follows/route.ts#L16) | `profile_bio.username` | text | safe |

The three `cached_listings.tier` rows are flagged with ⚠️ because they share a column **name** with the broken `editions.tier`, but they target a different table where `tier` is `text` (verified via `information_schema.columns`). They are functionally safe today. **Caveat for the future:** if `cached_listings.tier` is ever migrated to share the `tier_type` enum, all three become latent exposures and would need the same `.eq()`+`.toUpperCase()` treatment.

## Cross-reference against the 11 enum columns

| Enum column | `.ilike()` calls targeting it | Status |
|---|---|---|
| `editions.edition_kind` | 0 | clean |
| `editions.tier` | 0 (was 1; fixed in `e9c90e5`) | clean |
| `sets.tier` | 0 | clean — no `.from("sets")` calls in repo currently use `.ilike()` |
| `players.player_tier` | 0 | clean — no `.from("players")` calls use `.ilike()` |
| `collections.chain` | 0 | clean |
| `fmv_current.confidence` | 0 | clean — no `.from("fmv_current")` calls use `.ilike()` |
| `fmv_snapshots.confidence` | 0 | clean |
| `fmv_snapshots_2025.confidence` | 0 | clean |
| `fmv_snapshots_2026.confidence` | 0 | clean |
| `fmv_snapshots_2027.confidence` | 0 | clean |
| `pinnacle_fmv_snapshots.confidence` | 0 | clean |

## Type-verification SQL

This is the canonical query that proved the verdict. Persisted so future regressions on either side (a new `.ilike()` against an existing enum, or a new column gaining the enum type) are catchable.

```sql
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (
       (c.table_name = 'badge_editions'           AND c.column_name = 'player_name')
    OR (c.table_name = 'cached_listings'          AND c.column_name IN ('player_name','team_name','tier'))
    OR (c.table_name = 'editions'                 AND c.column_name IN ('player_name','set_name','team_name','tier','external_id'))
    OR (c.table_name = 'pack_table_rows'          AND c.column_name = 'title')
    OR (c.table_name = 'pinnacle_cached_listings' AND c.column_name IN ('character_name','set_name','variant_type'))
    OR (c.table_name = 'pinnacle_editions'        AND c.column_name IN ('character_name','set_name','variant_type'))
    OR (c.table_name = 'profile_bio'              AND c.column_name = 'username')
    OR (c.table_name = 'seeded_wallets'           AND c.column_name = 'username')
  )
ORDER BY c.table_name, c.column_name;
```

The only `USER-DEFINED` row in the result is `editions.tier` (`tier_type`), which has zero `.ilike()` callers post-`e9c90e5`.

## Recommended fix templates (for future use, not applied here)

If a new `.ilike()` against an enum column is introduced later, choose one of:

1. **Exact match (preferred when the enum is short and well-known)** — used by `e9c90e5`:
   ```ts
   query = query.eq("col", input.col.toUpperCase())
   ```

2. **Substring match (only when genuinely needed)** — use the raw filter API with an explicit text cast in the column reference:
   ```ts
   // PostgREST doesn't expose ::text casts on column names through .ilike(),
   // so this requires a Postgres view, an RPC function, or a raw fetch
   // against PostgREST. supabase-js .filter("col::text", "ilike", "%foo%")
   // does NOT work (the cast is not parsed). Path of least resistance is
   // a SECURITY DEFINER RPC that does the substring match server-side and
   // returns matching rows; or normalize input case-side to .eq().
   ```

   In practice, every existing concierge use case wants exact match (`tier="COMMON"`), so option (1) suffices.

## Closing

Audit closed. No corrective commits required. The `cached_listings.tier` text-column callers (sniper-feed, support-chat) remain safe today but are flagged for re-audit if that column is ever migrated to share the `tier_type` enum.
