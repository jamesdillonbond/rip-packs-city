> Subagent report from the 2026-09-06 Cowork deep-audit session (Trevor present). Read-only; every number is a dated live sample — re-measure before quoting. Actions taken on it are recorded in docs/overnight/ledger.md (2026-09-06 entries) and known-issues #59–#62.

# Findings — sitemap player 404s (A) and "Unknown · Squad Goals" (B)

## Defect A — sitemap and resolver derive `/player/<slug>` from DIFFERENT populations

**Sitemap source** — `/home/claude/rpc/lib/sitemap-data.ts:568-572` (segment 3): every `editions.player_name` in the 4 edition collections (TS fossils dropped) becomes `/<coll>/player/${slugifyName(player_name)}`. No join to `players`, no team-Moment check.

**Resolver** — `get_player_detail` (live `pg_proc`, called via `lib/entity-detail-gate.ts:44-67`, 404-gated in the segment layout): matches **only** `players.name` in the same collection:
```sql
FROM players p WHERE p.collection_id = p_collection_id
  AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
```
Slug functions are byte-equivalent (JS `lib/entity-labels.ts:56-58` vs the SQL regexp), so the gap is purely *which table*.

**Measured (2026-09-06, live):**

| collection | sitemap player URLs | would 404 |
|---|---|---|
| nba_top_shot | 1,413 | **57** (488 editions behind them) |
| nfl_all_day | 1,517 | 0 |
| laliga_golazos | 360 | 0 |
| ufc_strike | 381 | 0 |

The 57 are three classes:
1. **44 team Moments** (`player_name = team_name`: 30 NBA + 14 WNBA franchises, sets *Squad Goals / 2022-23 Season Rewind / WNBA Skyline*; 431 editions total). `dallas-wings`, `new-orleans-pelicans` are here. `/team/<same slug>` already resolves (`get_team_detail` reads `editions.team_name`) and is already in the sitemap — so these are pure duplicates-that-404.
2. **9 legacy players with no `players` row and NULL `player_id`** (Run It Back / Immortals / Heroes of the Game): `joe-dumars`, `toni-kukoc`, `emeka-okafor`, `dino-radja`, `david-lee`, `vernon-maxwell`, `courtney-lee`, `steve-kerr`, plus the literal `team-moment` (2 Clamps/Fit Check editions).
3. **4 diacritic mismatches** where `player_id` IS set but the names differ: editions `Vít Krejčí` / `Frieda Buhner` / `Noémie Brochant` / `Dražen Petrović` vs `players` `Vit Krejci` / `Frieda Bühner` / `Noemie Brochant` / `Drazen Petrovic`. Emitted slug `v-t-krej-` matches nothing. (Every in-app link — rookies, new-collectors, pack-drops boards — has the same problem for these.)

**Why it exists:** `ensure_players_from_edition_names()` (migration `20260802012214`) seeded the gap once on 08-01 and is **not scheduled** (`cron.job` has only `rpc-refresh-players-current-team`, jobid 249). Class 1 was then diagnosed on 09-04 and fixed for the edition page only — `lib/entity-href.ts:6-10` ("all 370 Top Shot team Moments … not one has a `players` row") — the sitemap copy of the expression was not grepped.

**Measurement SQL** (what will 404; re-run before/after):
```sql
with sm as (
  select e.collection_id, regexp_replace(lower(trim(e.player_name)),'[^a-z0-9]+','-','g') slug
  from editions e
  where e.collection_id in ('95f28a17-224a-4025-96ad-adf8a4c63bfd','dee28451-5d62-409e-a1ad-a83f763ac070','06248cc4-b85f-47cd-af67-1855d14acd75','9b4824a8-736d-4a96-b450-8dcc0c46b023')
    and coalesce(e.player_name,'')<>''
    and not (e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and coalesce(e.external_id,'') like '%-%')
  group by 1,2),
pl as (select distinct collection_id, regexp_replace(lower(trim(name)),'[^a-z0-9]+','-','g') slug from players)
select sm.collection_id, count(*) filter (where pl.slug is null) would_404, count(*) total
from sm left join pl using (collection_id, slug) group by 1;
```

### Proposed fix (three layers, same population)

**1. Sitemap — route team Moments to `/team/`, not `/player/`** (`lib/sitemap-data.ts:568`), reusing the 09-04 rule:
```ts
// was: if (e.player_name) { playerMap.set(`${coll.urlSlug}|${slugifyName(e.player_name)}`, ts) }
const isTeamMoment = !!e.team_name && e.player_name?.trim() === e.team_name.trim()
if (e.player_name && !isTeamMoment) { …playerMap… }   // team Moments already reach teamMap via e.team_name
```
Add a case to `__tests__/sitemap-data.test.ts` "segment 3": an edition with `player_name: "Dallas Wings", team_name: "Dallas Wings"` yields `/team/dallas-wings` and **no** `/player/dallas-wings` (assert the ABSENCE). Removes 44/57.

**2. Resolver — accept the unaccented slug** (`get_player_detail` + `get_player_editions` + `get_player_top_sales`; new migration, `SET search_path` functions must write `extensions.unaccent`), mirroring the fallback `get_team_detail` already has for Pinnacle:
```sql
AND (regexp_replace(lower(trim(p.name)),'[^a-z0-9]+','-','g') = p_player_slug
  OR regexp_replace(lower(trim(extensions.unaccent(p.name))),'[^a-z0-9]+','-','g') = p_player_slug)
```
Also make `slugifyName` NFD-strip (`name.normalize("NFD").replace(/\p{M}/gu,"")`) so the emitted slug is `vit-krejci` rather than `v-t-krej-`; both sides then agree for accented names. Fixes the 4.

**3. Data — schedule the existing self-heal** so class 2 cannot re-accrue: `cron.schedule('rpc-ensure-players-from-edition-names','50 9 * * *', $$select public.ensure_players_from_edition_names();$$)` (one-statement pg_cron; no-push lever). ⚠ Run it **after** step 1 ships or add `AND e.player_name IS DISTINCT FROM e.team_name` to its `missing` CTE, otherwise it seeds 44 junk "Boston Celtics" players rows. Also exclude the literal `'Team Moment'` name (2 editions) — better nulled: `update editions set player_name=null where player_name='Team Moment'`.

Optionally pin as a DB invariant: `sitemap player slugs ⊆ players slugs` = 0 (the measurement query above), so the next drift reds `db:pins:check`.

## Defect B — "Unknown · Squad Goals"

**Source:** `get_pack_detail_bundle` (live) builds `hero_editions` as `e.player_name, e.set_name …` from `editions` — no `team_name`. Shape: `lib/pack-dist/fetchers.ts:302-311` (`HeroEdition`, no `team_name` field). Render: `app/(collections)/[collection]/pack/dist/[distId]/page.tsx:1512` `{e.player_name ?? "Unknown"}` (also `alt=` at :1479).

**Data:** dist 1211's pool has one such row: edition `136:4807` (*Squad Goals*, RARE, `player_name` NULL, `team_name` "Charlotte Hornets", `player_id` NULL). Population: **151 canonical TS editions with NULL `player_name` — 151/151 have `team_name`**, 77 sit in live drop pools, 120 have FMV (plus 1,485 TS fossils and 36 AllDay *NFL Draft* rows with neither). So `team_name` is a complete fallback, not a partial one.

**Fix at the data layer (RPC), so every consumer inherits it:**
```sql
-- get_pack_detail_bundle hero select
coalesce(nullif(e.player_name,''), e.team_name) as player_name,
e.team_name,
```
and add `team_name: string | null` to `HeroEdition`; page: `{e.player_name ?? e.team_name ?? e.set_name ?? "—"}` (report, don't conclude "Unknown"). Do **not** `UPDATE editions SET player_name = team_name` — that would recreate Defect A class 1 for these 151 rows; the on-disk convention (NULL player + team) is the *correct* one and the 431 `player_name = team_name` rows are the inconsistent half.

**Same expression elsewhere** (`player_name ?? "Unknown…"`, 12 copies): `lib/collection/server-moment.ts:90`, `app/api/sets-db/route.ts:122`, `components/TrophySlab.tsx:392`, `components/profile/TopMoversCard.tsx:46`, `components/profile/PriceAlertsCard.tsx:127`, `components/analytics/{InsiderSignals:136,RecentWhaleTrades:108,BuybackDashboard:344,434}`, `app/share/[wallet]/page.tsx:355`, `app/(collections)/[collection]/profile/[username]/CollectionProfileClient.tsx:192`. A shared `momentSubjectName(player_name, team_name, set_name)` next to `momentSubjectHref` in `lib/entity-href.ts` is the right home; a ban-at-zero on the literal `?? "Unknown"` shape keeps it from spreading.

## Why the entity smoke missed A

`e2e/entity-urls.ts:37-40` `pickEntityPath` returns the **first** `/player/` `<loc>` in segment 3; `e2e/entity-smoke.spec.ts:79-89` probes exactly that one URL per type. Segment 3 iterates `playerMap` in insertion order = `editions` ordered by `updated_at DESC`, so the probe always lands on the most-recently-touched edition's player — nearly always a real `players` row. It is a "page renders" monitor with n=1, not a membership check, and 57/1,413 (4%) is invisible at n=1. A cheap addition: a `sitemap-players-resolve` arm that samples ~20 `/player/` locs by `abs(hashtext(slug)) % N` and asserts zero 404s — or, cheaper and deterministic, the DB pin above.