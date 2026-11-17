# Player hubs — one page per player name, across collections

**Status:** SHIPPED 2026-10-22 (PT), migration `20261023053026`, code `b7d6aa8ff` + `08c75bda3`. Trevor: searching "Damian Lillard" "has a weird feel to it", and Enter "takes me to the Damian Lillard page for Panini only … show both Top Shot and Panini". Sitemap listing added by another session the same night (`20261023073556`, `list_indexable_player_hubs`).

## What a hub is

`/players/<slug>` — e.g. `/players/damian-lillard` (NBA Top Shot 68 editions + Panini 129). One page per player NAME that gathers every collection carrying it. Each collection gets a panel with the SAME numbers its own player page shows (it reads the same `get_player_detail` / `get_player_editions`), its top 6 editions (load-more through `/api/entity/player`), and a link into that page. Disney Pinnacle is excluded — its "players" are characters.

A name only ONE collection carries has nothing to gather: the hub **307s** to that collection's player page (307, not 308 — the next mint can make it a hub). A name no collection carries 404s. A failed read renders "Player hub unavailable" (never a 404); a failed panel renders unavailable (never "no editions").

## ⚠ A name is not a person

No person key spans collections: Panini's 4,884 players carry 0 `player_identities` rows (Top Shot and All Day are keyed to NBA/NFL ids; nothing links them to Panini). So the hub matches by **name** — the site's unaccented slug, plus every spelling `player_name_aliases` links in either direction (`/players/steph-curry` and `/players/stephen-curry` both gather Top Shot "Steph Curry" + Panini "Stephen Curry") — and the page **groups by SPORT**:

| collection | sport |
|---|---|
| NBA Top Shot | basketball (Top Shot carries the WNBA too) |
| NFL All Day | football |
| LaLiga Golazos | soccer |
| Candy MLB | baseball |
| UFC Strike | mma |
| Panini | the distinct `panini_products.last_grid_sport` of the player's editions, via the `packcard-<set_id>_` prefix ("Womens Basketball" folds into basketball). All 38,893 player-linked Panini editions resolve; 4 Panini player rows span two sports and appear in both groups |

When a name spans two sports the page says "More than one athlete carries this name" and shows each sport as its own section, never added together. Measured 2026-10-22: 1,985 slugs appear in 2+ collections; all but 3 are a single-league collection + Panini of the same sport; **larry-johnson, matt-ryan, joe-johnson** span NBA and NFL. Indexable (`playerHubIsIndexable`) only when one sport group gathers 2+ collections.

## Pieces

| Layer | Piece |
|---|---|
| DB | `get_player_hub(slug)` (service_role) → `{slug, canonical_slug, name, collections[{collection_id, collection_slug, name, player_slug, edition_count, headshot_url, sports}]}`; edition counts use `rpc_search_catalog`'s own expression so the search row and the hub agree; NULL = no collection carries the name. ~27 ms / 638 buffers for Lillard |
| App | `app/players/[slug]/page.tsx` (+ layout, loading), `lib/player-hub.ts` (fetch, `groupBySport`, panels, editions), `lib/player-hub-path.ts` (leaf, no server import) |
| App | every per-collection player page links "<Name> across every collection (A + B) →" when 2+ collections carry the name (streamed; a failed read omits the link) |
| Search | `/api/search` → `lib/search/player-hub-hits.ts`: every non-Pinnacle player row links the hub; rows of one slug collapse into ONE row at the first row's position ("Panini Blockchain + NBA Top Shot · 197 editions") |
| Proxy | `/players/<slug>` public (exactly one segment) and page-rate-limited; `players` is in `lib/routing/known-top-level.ts` (the auth-boundary list) |
| Smoke | `e2e/smoke.spec.ts` renders `/players/damian-lillard` |

## Teams — the same move, for franchises

Team search rows open the franchise hub (`/teams/<league>/<slug>`) and the hub carries Panini cards: see [franchise-hubs.md](franchise-hubs.md), section "Panini on the hubs (2026-10-22/23)".

## Known limits

- Two people with one name in the SAME sport and collection are already one player row there; the hub inherits that collection's page (split/merge is the per-collection job — [player-identity.md](../reference/player-identity.md)).
- The search dropdown can still show two rows for one person when the collections spell the name differently and no alias links the slugs (each row still opens a hub that gathers both when an alias exists).
- Panini dual-player cards ("Damian Lillard | Donovan Mitchell") are their own Panini player row and are not on either player's hub.

## Revert

`git revert b7d6aa8ff 08c75bda3` (the new files rode the ledger commit `08c75bda3`); DB `DROP FUNCTION public.get_player_hub(text);`. The sitemap reader `list_indexable_player_hubs` (another session) would then list hubs that redirect — revert it with them.
