# Top Collector Leaderboard — top collectors of every team and player (code name: Top Fans)

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

## Schedule — live since 2026-11-27 ~6:20 PM PT

Three `cron_heavy` pg_cron jobs, applied through the Supabase dashboard SQL editor because the MCP approval check refused `cron.schedule` twice. File: `supabase/migrations/20261128021500_audit_20261127_entity_top_fans_cron.sql` (a record only; that version is not in `schema_migrations`).

| jobid | job | PT | collections |
|---|---|---|---|
| 955 | `rpc-entity-top-fans-panini` | 2:15 AM | Panini |
| 956 | `rpc-entity-top-fans-topshot-candy` | 2:45 AM | Top Shot, Candy |
| 957 | `rpc-entity-top-fans-rest` | 2:56 AM | All Day, Golazos, UFC, Pinnacle |

Once a collection’s Dune census lands, `refresh_entity_top_fans` skips it (logs `skipped: dune_census_owns_this_collection`), so these jobs only keep Panini, Candy and not-yet-censused collections fresh.

Revert: `SET LOCAL ROLE cron_heavy; SELECT cron.unschedule('rpc-entity-top-fans-panini'); SELECT cron.unschedule('rpc-entity-top-fans-topshot-candy'); SELECT cron.unschedule('rpc-entity-top-fans-rest'); RESET ROLE;`

## 2026-11-27 evening — leaderboard only from a FULL census; renamed

Trevor (4:51 PM PT): "We need to have this for every possible wallet, not just the ones we've captured. I don't think I should be the top collector for blazers." Then: "Call it top collector leaderboard, not top fan leaderboard."

- **Renamed** to "Top Collector Leaderboard" (section title, column "Collector").
- **Ranked only where the owner source is a full census** — `TOP_COLLECTORS_FULL_CENSUS` in `lib/entity/top-fans-format.ts`: Panini (every serial) and Candy (daily wallet census). Every other collection renders "waiting on a full on-chain count of every wallet" and is not read. Why, measured 11-27: Top Shot walked/indexed wallets = 12,063 owners of ~50.5 M minted Moments (the id→edition map covers 5.36 M ids); All Day / Golazos / UFC = wallets looked up on RPC only; Pinnacle's owner map sees 477 k of 1.62 M minted pins (it starts at the Dec 2025 spork).
- **The full census source is Dune** (`flow.cadence_events` from 2020: `<Contract>.MomentMinted` / `Deposit` / `Withdraw`, latest Deposit per id = owner — the shape of query 7899011). Plan: one Dune query per collection that aggregates on Dune's side to (entity, owner) using an inlined VALUES map of our editions (set/play[/sub] → player key, team key, FMV, circulation, jersey), keeps the top 25 per metric and the per-entity totals, and is paged into `entity_top_fans` by a route on the `dune-proxy` worker (as `sync-topshot-ownership-dune`). ⛔ **Blocked:** the Analyst plan's 4,000 credits for the cycle are spent (11-14/15 acquisition staging); the cycle resets **12/14**. Extra credits are $1.875 / 100 once the team's "Limit extra credits" is raised above $0 (Team settings → Plan) — Trevor's call.
- **Usernames** (Trevor: "figure out usernames for those pinnacle users"): leaderboard owners came from mint/ownership maps that no username lane read (679 of 840 Pinnacle owners unnamed). One-off Atlas dispatch 4:38 PM PT → 838 / 840 named; standing: `queue_top_collector_usernames()` (migration 20261128010040) runs at the end of every refresh and queues Atlas lookups into `member_wallet_username_requests`, drained by pg_cron 650.
- Daily schedule: applied 11-27 ~6:20 PM PT via the dashboard SQL editor (see Schedule above).

## Full census pipeline (built 2026-11-27 evening; first run after the Dune credit reset)

Trevor 5:09 PM PT: "Keep going. We're going to wait" (for the 12/14 Dune cycle rather than buying extra credits).

| piece | where |
|---|---|
| SQL generator + per-collection config | `lib/dune/top-collector-census.ts` (`censusSql`, `TOP_N` = 15) · print: `npx tsx scripts/print-top-collector-census-sql.mjs <topshot\|allday\|golazos\|pinnacle>` |
| saved Dune queries (public) | Top Shot **9205180** · All Day **9205183** · Golazos **9205184** · Pinnacle **9205185** — SQL identical to the generator (checked 11-27); ⚠ never executed yet |
| upload | `dune-proxy` `POST /upload_csv` — only `rpc_census_map_(topshot\|allday\|golazos\|pinnacle)`; query allowlist gained the four ids |
| route | `/api/cron/top-collector-census-dune?collection=<slug>` (resume: `&execution_id=`) — pipeline `top-collector-census-dune`; ok only if every result row was keyed and staged |
| schedule | `.github/workflows/top-collector-census.yml`, Mondays 12:23 UTC (4:23 AM PT), first 12/15; dispatch for one collection |
| DB | migration `20261128020000_audit_20261127_top_collector_census` (applied 11-27 ~6:05 PM PT through the dashboard SQL editor; the first draft never left its session, this one was rebuilt from the route + generator). Adds `top_collector_census_map(_csv)` (Top Shot `ek` = `set:play:sub`, 0 = Standard), `entity_top_fans_census_stage`, `stage_/finalize_top_collector_census` (finalize refuses an empty or short stage, then queues usernames for the new owners), the refresh skip for a `dune_census` collection, and `census_complete` in the reader. |

How it decides an owner: the latest `<C>.Deposit` or Cadence-1 `NonFungibleToken.Deposited` (type `<C>.NFT`) per NFT id, unless a later `Withdraw` / `Withdrawn` / burn / `NFT.ResourceDestroyed` means it is in nobody's collection. System accounts (`flowty_excluded_addresses`) ride in the map as `kind='exclude'`.

**First-run checks (12/15):** credits per execution and per MB exported (`getUsage` before/after) · `NonFungibleToken.Deposited` `$.type` really is the `A.<addr>.<C>.NFT` string in Dune's `data` · `$.to` comes back `0x`-prefixed hex · Top Shot holders/items for one team vs the old partial numbers (expect far more owners) · `rows_unkeyed = 0` · the Blazers Top Shot #1 is no longer only the wallets RPC walked. UFC is not in the census (its editions key on a name slug, not the on-chain set) — it stays "waiting".

The page needs nothing else: `get_entity_top_fans.census_complete` flips to true when a collection's run source is `dune_census`, and the server stops sending a partial ranking before that (`rankingIsCensus`).

## Overlap left in place

The older "Top Collectors" panels on the player page (Top Shot rookie index with its coverage note, Candy census, Pinnacle owner map) still render above Top Fans. They rank the same people by value; retiring them is a follow-up (tests pin them: `panini-entity-pages`, `pinnacle-top-collectors-unknown-mint-is-not-zero`).

## Revert

```sql
DROP FUNCTION IF EXISTS public.get_entity_top_fans(uuid, text, text, text, integer);
DROP FUNCTION IF EXISTS public.refresh_entity_top_fans(uuid);
DROP TABLE IF EXISTS public.entity_top_fans, public.entity_top_fans_totals, public.entity_top_fans_runs;
```
Code: `git revert` the commit "Top Fans on every team and player page and both hubs" (by message).

## 2026-11-27 ~6:50 PM PT — the older walked-wallet "Top Collectors" panels retired

The player page still carried three pre-leaderboard rankings, each over a partial owner set: Top Shot (`get_topshot_rookie_collectors`, the rookie ownership index), Pinnacle (`get_pinnacle_character_top_collectors`, the owner map from Dec 2025), and Candy (`get_candy_player_top_collectors`, a full census, but a duplicate of the leaderboard's Candy tab). Two of them published exactly the partial ranking Trevor rejected, on the same page where the leaderboard says "waiting on a full count". All three are removed; the Top Collector Leaderboard is the one ranking. The year-end rookie cut lines, which were drawn inside the Top Shot panel, now have their own **Rookie Cut Lines** section (Top Shot 2026 class only). The database functions are untouched (other surfaces may read them). `lib/entity/index-coverage-note.ts` had no other caller and was deleted. Tests re-pinned as absences: `panini-entity-pages`, `rookie-cut-lines`, `pinnacle-top-collectors-unknown-mint-is-not-zero`.
