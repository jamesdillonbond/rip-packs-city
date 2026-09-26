# Player identity, name variations and the stats feed

Written 2026-09-25 (PT) at the close of the crosswalk thread (#139; batches 44–61 in `docs/overnight/ledger.md`). Every number here is a dated sample — re-derive before quoting. The canonical rule lives in CLAUDE.md (Concierge rule 2): **a NAME is not a PERSON; a team label is not a FRANCHISE.**

## The model

A collector types a label; the catalog holds people. Between them sit five kinds of variation, and RPC now carries data for each:

| variation | example | where it lives |
|---|---|---|
| a second spelling of one person | Joseph / Joe Flacco, Stephen / Steph Curry, Kenneth / Kenny Gainwell | `player_name_aliases` (`alias_slug` → `player_id`; the URL 308s, the name writers never re-mint it) |
| the league's spelling vs RPC's | nflverse "Mike Vick" / All Day "Michael Vick"; "Deebo Samuel Sr." | `player_identities.display_name` (the league's) beside `players.name` (RPC's); `resolve_player_name` reports `league_name_differs` |
| a name change | Robby Anderson → Robbie Chosen (2022), the Jaguars' Josh Allen → Josh Hines-Allen (2024), Enes Kanter → Enes Freedom, Skylar Diggins-Smith → Skylar Diggins, Betnijah Laney → Laney-Hamilton, Megan Gustafson → Megan DiLeo | `player_relations` (`relation = 'name_change'`, `name` = the other name) **and** an alias for the other spelling |
| a father and son (or an unrelated namesake) | Marvin Harrison / Jr., Gary Payton / II, Tim Hardaway / Jr., Larry Nance / Jr., Ron Harper / Jr., Glenn Robinson / III, Antoine Winfield / Jr., Asante Samuel / Jr., Joey Porter / Jr.; Byron Murphy Jr. (CB) vs Byron Murphy II (DT) — unrelated | `player_relations` (`parent_of`, `namesake`), hand-curated, public record only |
| a franchise under several labels | Las Vegas / Oakland / Los Angeles Raiders; Washington Commanders / Football Team; SuperSonics → Thunder, Bullets → Wizards, Bobcats → Hornets, "Los Angeles Clippers" → LA Clippers; San Antonio Stars → Aces | `league_team_abbr(p_league)` = `teams_master` + a VALUES list of historic names (`nfl`, `nba`, `wnba`) |

Underneath: **`player_identities`** is the crosswalk — `league` (`nba` for Top Shot, `nfl` for All Day) + `league_player_id` (NBA person id / NFL GSIS id), `player_id` → the RPC row, the league's `display_name`, seasons and latest team (nflverse for NFL; derived from the player's own ESPN stat lines for the NBA half), `espn_id` + `espn_league` (`nba` | `wnba` | `nfl`), `matched_by` (how the row was keyed: `name`, `suffix+team`, `hand:2026-09-25`, `resolver`…). `base_slug` is the name slug with the generational suffix removed. Every name writer resolves through it where the identity is feed-backed: the daily linker (`link_editions_to_players_by_name`, `rpc-link-editions-to-players` 2:55 AM PT), the seeder (`ensure_players_from_edition_names`) and wallet-search's `resolve_canonical_player`.

## The resolvers (service_role only, both pinned)

`resolve_player_name(collection_id, name)` → `one` | `ambiguous` | `none`. Arms in order: exact spelling → alias → the league's spelling → a recorded former name → the base name with the suffix dropped ("X Sr." names the unsuffixed row) → a partial that matches exactly one player. `one` carries `player` (id, name, the SITE's slug — a trailing "." keeps its dash, `/player/marvin-harrison-jr-` — team, edition count, **`labels`**: every `editions.player_name` the person's editions carry), `aliases`, `identity`, `relations` (as seen from this player: `parent_of` / `child_of` / `unrelated_namesake` / `also_known_as`), `namesakes` (every other row sharing the base name, each described the same way, plus any row whose former name is the query) and a `note` when namesakes exist. `ambiguous` carries `candidates` in the same shape.

`resolve_team_name(collection_id, name)` → `one` | `ambiguous` | `none`. Every team label of the collection is keyed to a franchise (`map:<league>:<abbr>` via `league_team_abbr` — nfl; nba **and** wnba for Top Shot, namespaced so the Mystics' WAS never folds into the Wizards' — else `tm:<league>:<abbr>`, else the label itself), a matched franchise expands to **all** its labels, `primary_name` is the `teams_master` name (else the most-minted label), `historic_names` carry edition counts. An exactly-typed primary name decides among several franchises.

## How the concierge uses them

`app/api/support-chat/route.ts` — `executeTool` resolves the typed player name **once** for the six label-keyed tools (`search_live_deals`, `search_catalog_deals`, `get_edition_listings`, `search_serial_deals`, `get_special_serial_owners`, `get_badge_info`): `player_name IN (labels)` or `player_id` where the table has it, candidates on `ambiguous` (nothing searched), the tool's own ILIKE when the read is `none` or **`unavailable`** (the fourth state, `lib/concierge/player-identity.ts` — a failed read is never "no such player"). `get_player_editions` / `get_fmv` / `search_catalog_deals` resolve and attach `player_identity`; `resolve_player_name` is also a tool ("who is X / are they related"). `get_team_intel` resolves to the franchise, reads the primary name and attaches `franchise` (historic labels with counts). Prompt sections: **Names are not people**, **Teams are franchises**. Pinnacle (characters) and `search_across_collections` are not scoped.

## The stats feed (ESPN, public JSON, a GitHub Actions runner)

`player_season_stats` ← `scripts/sync-player-stats.mjs` → Bearer route `/api/cron/player-stats-sync` (every 6 h at :23 UTC; GitHub sheds ticks often — dispatch by hand with `POST /actions/workflows/367381062/dispatches`). Per player: `site.web.api.espn.com/apis/common/v3/sports/{football/nfl | basketball/nba | basketball/wnba}/athletes/<espn_id>/stats`. Facts measured 2026-09-25:

- **Search is `/apis/search/v2?query=&type=player`**, not the v3 `common/v3/search` — v3 is active-only and returns no WNBA; v2 returns retired players, carries the athlete id in `uid` (`s:40~l:46~a:662`) and the league in `defaultLeagueSlug`.
- ESPN keeps **duplicate athlete entries**: a G League affiliate copy (`nba-development` — Fultz on "Raptors 905" with the same id the NBA path serves), a phantom with no team, and a player now abroad filed under `fiba` / `nbl` with the same id (Šarić, Vanloo). The runner settles a same-name set by a **stats probe** — the one candidate whose stats page has seasons — and leaves two real players ambiguous (Dee Brown; Courtney Williams ×2 in the WNBA). College leagues are never candidates.
- A stats page of `{ filters:[…] }` with **no `categories`** is ESPN's "no stat lines" (an offensive lineman) — an answered empty, zero rows; a payload with neither is a failed read. A traded season is one line per team plus a "<year> Totals" line (`is_total`, `team_slug ''`).
- One failed fetch or search in 300–400 is noted, not a failed run (< 5 %); a failed search leaves its target for the next tick; a 500 on a retired player's id (5 as of 7:35 PM PT) is retried every tick, harmlessly.
- `get_player_season_stats(player_id, seasons)` → NULL (no identity / no espn_id — the page renders nothing) | rows `[]` ("no season stats from the feed yet") | rows; it returns `espn_league` so a WNBA season is labelled by its calendar year. The section lives on every Top Shot / All Day player page.
- State at close (7:35 PM PT 09-25): Top Shot 1,288 / 1,317 identities keyed (1,015 NBA + 273 WNBA), All Day every person nflverse knows; 60,725 lines over 2,605 players. The 29 unkeyed are ESPN's gaps (1980s–90s players; Patty Mills' fiba id serves no NBA lines).

## Maintenance — what a future pass adds by hand

- **A new father/son, an unrelated same-name pair, or a rename** → a `player_relations` row (and an alias for the other spelling of a rename). The same-base-name query is in the header of migration `20260926011020`; the resolver reports an unrecorded pair as "kinship NOT recorded", never guesses.
- **A new historic team label** (a relocation or rename appearing in `editions.team_name`) → a VALUES row in `league_team_abbr` (the unmapped-label query is in the header of `20260926021808`). The franchise HUB still counts the current name only — folding historic-era moments into it is a product call (the hub's per-collection numbers would change).
- **Decisions on record (delegated, 09-25):** no renames to the league's spelling — the alias carries it and the concierge names both; keep accent-collapsed canonical slugs (`/set/-dolos`) with the plain spelling 308ing to them.
