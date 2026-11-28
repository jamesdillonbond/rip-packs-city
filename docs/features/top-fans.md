# Top Fans — top collectors of every team and player

Shipped 2026-11-27 (Claude Code cloud). Trevor: "Each team and player should have top fans on their hubs. This should reflect on their collection-specific hubs, along with a similar table on their aggregated hubs, with those tables showing filters/toggle-able for each of the supported collections. These tables should show top collectors by Moment/Pin/Card count, FMV, and special serial count owned (only count each Moment/pin/card once, if they have multiple special serials on it like a 1/1 that is both #1 and perfect)."

## Where it shows

| surface | read |
|---|---|
| `/<collection>/team/<slug>` (incl. Pinnacle franchises) | `team`, key = the page slug |
| `/<collection>/player/<slug>` and `/disney-pinnacle/character/<slug>` | `player`, key = that collection's `players.id` + name (Pinnacle keys on the character name) |
| `/teams/<league>/<slug>` (franchise hub) | one `team` read per collection panel that answered + Panini `franchise` (`NBA:blazers`); chips switch collection |
| `/players/<slug>` (player hub) | one `player` read per ok panel, **one table per sport group** (a name is not a person) |

Rank toggle: Moments / Pins / Cards (by collection) · FMV (default) · Special serials (disabled on Pinnacle: serials not tracked).
Components: `components/entity/TopFansSection.tsx` (server, fetch) → `components/entity/TopFansTable.tsx` (client). Pure helpers: `lib/entity/top-fans-format.ts`, `lib/entity/top-fans-targets.ts`. Tests: `__tests__/top-fans.test.ts`.

## Data

Migration `20261128000240_audit_20261127_entity_top_fans.sql`.

- `refresh_entity_top_fans(collection_id)` rebuilds one collection in one transaction (readers see the old set until COMMIT), logs pipeline `entity-top-fans` (`ok=false` + error on failure; previous set stands).
- `entity_top_fans` keeps only owners ranked ≤ 25 by ANY metric per entity (the Panini player grain alone is 2.2 M owner rows). `entity_top_fans_totals` = holders / items per entity. `entity_top_fans_runs` = last refresh per collection.
- `get_entity_top_fans(collection_id, kind, key, name, limit)` (service_role only) returns NULL when the collection was never refreshed (rendered "couldn't load", never "no fans"), else the union of the top `limit` by each metric. `holders` is NULL when a team spans several labels (an owner could be under each).

Owner sources (the copy under each table says which):

| collection | source | note |
|---|---|---|
| Top Shot | `wallet_moments_cache` ∪ `topshot_ownership` (`walk_missed_at IS NULL`), one row per Moment id, newer observation wins | partial: wallets RPC walked + the index's sets |
| All Day, Golazos, UFC | `wallet_moments_cache` | wallets RPC has looked up only |
| Candy | `wallet_moments_cache` (daily full census); treasury + ME escrow excluded | ⛔ never lower() a Solana key |
| Panini | `panini_card_serials` by owner username; blank owner and BURNT excluded | special = `is_special` |
| Pinnacle | `mv_pinnacle_render_owners`, `NOT is_system` | no serials → special NULL |

Special serial = #1, perfect (serial = edition circulation) or jersey (serial = `editions.jersey_number`), in ONE `count(*) FILTER (… OR … OR …)` — a 1/1 counts once. FMV = edition FMV (`edition_fmv_current`; `candy_fmv_current`; `pinnacle_catalog.fmv_usd`) × items; `fmv_items` < items shows an asterisk.

First fill 2026-11-27 ~4:00–4:12 PM PT (run times, as `postgres`): Top Shot 78 s (2.80 M Moments, 12,063 owners) · Candy 47 s · All Day 28 s · Pinnacle 7 s · Golazos 3 s · UFC 2 s · **Panini 216 s** (a full scan of `panini_card_serials`, ~1.1 M buffers; it dies at the 120 s `postgres` default, so it needs `cron_heavy`'s 600 s).

## Schedule — ⚠ NOT YET SCHEDULED

The daily cron (three `cron_heavy` jobs at 2:15 / 2:45 / 2:56 AM PT) is drafted in the 11-27 handoff but was **not applied**: the session's approval for the `cron.schedule` migration was refused. Until it is, the tables are a one-off fill dated 11-27. Apply it (SQL below), then commit it as `supabase/migrations/<version>_audit_20261127_entity_top_fans_cron.sql`.

```sql
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-entity-top-fans-panini', '15 10 * * *',
  $$SELECT public.refresh_entity_top_fans('d1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid)$$);
SELECT cron.schedule('rpc-entity-top-fans-topshot-candy', '45 10 * * *',
  $$SELECT public.refresh_entity_top_fans('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid), public.refresh_entity_top_fans('209ade70-32c5-4470-bc7c-4793d660f713'::uuid)$$);
SELECT cron.schedule('rpc-entity-top-fans-rest', '56 10 * * *',
  $$SELECT public.refresh_entity_top_fans('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid), public.refresh_entity_top_fans('06248cc4-b85f-47cd-af67-1855d14acd75'::uuid), public.refresh_entity_top_fans('9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid), public.refresh_entity_top_fans('7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)$$);
RESET ROLE;
```

## Overlap left in place

The older "Top Collectors" panels on the player page (Top Shot rookie index with its coverage note, Candy census, Pinnacle owner map) still render above Top Fans. They rank the same people by value; retiring them is a follow-up (tests pin them: `panini-entity-pages`, `pinnacle-top-collectors-unknown-mint-is-not-zero`).

## Revert

```sql
DROP FUNCTION IF EXISTS public.get_entity_top_fans(uuid, text, text, text, integer);
DROP FUNCTION IF EXISTS public.refresh_entity_top_fans(uuid);
DROP TABLE IF EXISTS public.entity_top_fans, public.entity_top_fans_totals, public.entity_top_fans_runs;
```
Code: `git revert` the commit "Top Fans on every team and player page and both hubs" (by message).
