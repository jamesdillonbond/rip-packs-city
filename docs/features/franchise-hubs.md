# Franchise hubs — one page per real-world team, across collections

**Status:** foundation SHIPPED 2026-09-23 (PT). Trevor's call: "Both, foundation first" — build the hub foundation now, then scope Panini NBA/MLB ingest as a follow-up with its own accuracy check.

## What a hub is

`/teams/<league>/<short slug>` — e.g. `/teams/nba/blazers`, `/teams/mlb/tigers`. One page per franchise that gathers **every collection carrying that team**. Each collection gets a panel with the same numbers the per-collection team page shows (the panel reads the SAME `get_team_detail`, so the two cannot disagree) and a link into that page.

The goal from the thread that started this: the **Blazers** hub shows Top Shot + Panini NBA cards; the **Tigers** hub shows Candy MLB + Panini MLB cards.

## What shipped (2026-09-23)

| Layer | Piece |
|---|---|
| DB | `league_t` gains `MLB` (migration `franchise_hub_20260923_league_t_adds_mlb`) |
| DB | `teams_master` gains the 30 MLB clubs, `team_name` spelled exactly as Candy's `editions.team_name` ("Angels", "Athletics") — the branding join keys on slugify(team_name) |
| DB | `league_collections(league, collection_id, display_order, enabled)` replaces the league→collection `CASE` hardcoded in two functions. **A league can map to several collections** — that is the hub |
| DB | `get_franchise_hub(p_league, p_team_slug)` — branding + every ENABLED mapped collection; NULL = no such franchise |
| DB | `get_my_fan_teams` reads its primary collection from the map and now returns `team_slug`; `get_teams_for_league.has_moments` checks every enabled mapped collection |
| App | `app/teams/[league]/[slug]/page.tsx` + `lib/franchise-hub.ts` (three states per panel: ok / empty / failed) |
| App | `/my-teams` cards open the franchise hub; MLB is a followable league; the bound wallet is passed to a team's checklist **only when its chain matches** the collection (a Flow wallet against Candy would have read as "you own 0") |
| App | `proxy.ts`: `/teams/<league>/<slug>` is public and page-rate-limited |

**Indexing.** A hub is `noindex, follow` until it gathers **2+** enabled collections (`hubIsIndexable`) — a one-collection hub is a near-duplicate of the per-collection team page. It is not in the sitemap yet for the same reason.

## Why every hub shows ONE panel today

RPC's Panini data is **100% FIFA World Cup 2026 soccer** (Prizm World Cup, `setId 2332`, walked from `marketplace/nfts.html?sport=Soccer`). There are no Panini NBA or MLB cards in the database, so no Panini panel can exist yet. Measured 2026-09-23: `panini_editions` has 5,090 rows across 62 soccer sets; its only people columns are `player_name` and `nation`.

Panini's marketplace **does** carry live Basketball and Baseball NFTs (verified in Chrome 2026-09-23: LeBron James, Wembanyama, Ohtani listings), and the runner's grid response (`getMarketPlaceList` → `products.items[]`) carries a **`team`** field — for soccer it holds the nation, which is where `nation` comes from (`nationByPsku` in `scripts/ingest-panini-runner.mjs`). The first capture (below) confirmed it: full club names for NBA, city only for MLB.

## Follow-up: Panini NBA + MLB — first capture (2026-09-24, measured)

**How it was read.** Panini signs every `/onepanini` request, so replaying the API is off the table. The grid's items live in the page's React state after the SPA fetches them; a read-only walk of the fiber tree (Claude in Chrome, Trevor's logged-in Chrome) returns the same `products.items[]` objects the soccer runner intercepts — ~137 fields each, including `team`, `athlete`, `cardset`, `genesis_year`, `nft_type`, `end_seq`, `buy_now_price`. Paging is `nfts.html?sport=<Sport>&p=<N>`, 30 items a page; a page past the end renders empty. Sample: 11 Basketball pages spread from p1,000 to p5,000 plus p20–p500 (286 distinct pskus) and 7 Baseball pages from p1 to p1,000 (169 pskus); p1,500+ Baseball and p100,000 Basketball render empty.

| | Basketball (NBA) | Baseball (MLB) |
|---|---|---|
| Grid depth | ~4,800 pages ≈ **140k listed NFTs** | ~1,000–1,500 pages ≈ 30–45k |
| `team` populated | 286 / 286 pskus (100 %) | 169 / 169 (100 %) |
| What `team` holds | **Full club name** ("Portland Trail Blazers") | **City only** ("Los Angeles", "New York", "Chicago") — Panini's MLB cards carry no club names |
| Matches `teams_master` spelling | All but one: Panini "Los Angeles Clippers" vs ours "LA Clippers" | n/a — needs resolution |
| Multi-team cards | 10 / 286 (3.5 %) as "A \| B" | 1 / 169 |
| Former franchises | "Seattle SuperSonics", "New Jersey Nets", "New Orleans Hornets" | "Oakland" |
| Years (`genesis_year`) | 2020–2025 | 2020–2022 only |
| Set ids (psku prefix) | ~20+ (`packcard-1783`, `-1602`, `-1587`, …) | 4 main (`packcard-1661`, `-1608`, `-1574`, `-1583`) |

Examples: **Blazers** — Scoot Henderson, Donovan Clingan, Toumani Camara, Carmelo Anthony (2020-21 Prizm) … 8 in the sample. **Tigers** — Javier Báez, Akil Baddoo, Casey Mize (all 2022; "Detroit" is unambiguous).

**What that means.**

1. **NBA is clean enough to build on.** Map `team` through `teams_master` with a small alias table (Clippers; the three former franchises → their current `teams_master` row; see decision below). Split "A | B" cards into one row per team so a two-team card shows on both hubs.
2. **MLB is not a string match.** "Los Angeles" is Dodgers *or* Angels, "New York" Yankees *or* Mets, "Chicago" Cubs *or* White Sox — 56 of 169 sampled pskus (33 %) are one of those three cities. Resolving them needs player + year → club (Ohtani 2022 "Los Angeles" = Angels; Judge "New York" = Yankees, Alonso = Mets). Every other MLB city is a single club. And the product stops at 2022.
3. **Scale.** ~140k listed NBA NFTs against the 5,090 soccer editions the runner walks today — at least an order of magnitude more. Enumeration must come from the grid (one read per 30 cards), not per-card detail pages. Pricing — the accuracy gate — still needs per-card sale history, which is the expensive signed walk; that is the real cost of this follow-up.
4. **The grid is LISTINGS**, same coverage caveat as soccer: an edition with no live listing does not appear. Fine for "what can I buy for my team", not a full checklist.

**Recommended order:** NBA first (full names, larger market, Blazers). MLB second, behind a player→club resolver for the three shared cities.

**Decided 2026-09-24 (Trevor: "do what you think is best"):** a card printed under a former franchise counts for the current franchise — SuperSonics → Thunder, New Jersey Nets → Nets, New Orleans Hornets (2002–13) → Pelicans, Charlotte Bobcats → Hornets, Vancouver Grizzlies → Grizzlies, Oakland → Athletics. Encoded in `panini_team_aliases`.

## Team walk — pilot shipped (2026-09-24)

**The lever that made it cheap:** the grid takes a **team filter** — `nfts.html?sport=Basketball&team=Portland%20Trail%20Blazers&p=N` returns only that team (measured: 26/26, 24/24, 29/29 Blazers). So a hub needs its own team's pages, not the whole 4,800-page sport: Blazers > 40 pages (1,200 listings in the first 40; ends somewhere in 150–250), Detroit (MLB) 35 pages / 1,020 listings in ~3 min, ending on an empty page.

**Where it runs — measured, not assumed.** A headless walk from the Cowork cloud sandbox works anonymously. The same script on **GitHub Actions got HTTP 403 with Cloudflare's 1000-series error box** on page 1 of both targets (run 2026-09-24 7:32 AM PT) — the Atlas story again. So the walk runs on **Trevor's box**, in the soccer runner's debug Chrome (`PANINI_CDP_URL`), posting to `/api/cron/panini-team-walk` with `INGEST_SECRET_TOKEN`. The GitHub Actions workflow was removed the same hour.

**Rotation (2026-09-24 evening, Trevor: "do it").** The walk left `panini-run.bat` — it was sharing the soccer task's 2-hour limit — for its **own daily task, `RPC Panini Team Walk`, 3:35 AM** (`scripts\panini-team-walk.bat`, registered once by `scripts\panini-team-walk-schedule.bat`), between the soccer runner's 2 AM and 6 AM slots. Each run asks the receiver (`op: plan`) for the **5 least-recently-attempted teams** on the roster `panini_team_walk_targets` (30 NBA + Detroit), so every team is walked about once a week; it will not *start* a team after 100 minutes (`PANINI_WALK_BUDGET_MIN`). Heartbeat and finish stamp the roster (`panini_team_walk_note`); only an ok walk stamps `last_complete_at`. Log: `%USERPROFILE%\panini-team-walk.log`.

**Registered 2026-09-24 9:20 PM PT (verified).** `schtasks /query` on LAPTOP-E3BDP9VS: `\RPC Panini Team Walk`, Status Ready, **Next Run 9/25/2026 3:35 AM**, ⚠ **Logon Mode "Interactive only"** — like the other laptop tasks it runs only while Trevor is signed in, so a signed-out night is a skipped walk, not a failure. The checkout was already at `18cd5c49a` with both bats present. First unattended run: 9/25 3:35 AM; read the log above and `panini_team_walk_targets.last_complete_at` to judge it.

**Two nets under the end-of-list signal (found while dry-running the rotation).** Panini answered page 1 for the **Hawks and the Jazz with an empty list, then 30 listings minutes later**. An empty page is the only end-of-list signal and it retires listings, so: (1) the walker re-reads an empty page after 20 s and a fresh navigation before believing it; (2) `panini_team_listings_ingest` refuses to retire when a "complete" walk saw fewer than half of the team's active listings (`retire_skipped`), and the walker reports that run ok=false. A third guard stops a walk whose page carries another team's cards (the filter did not hold) before anything from that page is written.

**First laptop runs (2026-09-24, measured).** The 2 PM PT pass walked Detroit completely, but **Blazers died at p15**: two back-to-back products answers that were HTML, not JSON. Then the process **never exited**. Over CDP the script skipped `browser.close()`, the websocket kept node alive, and Task Scheduler's 2 h limit killed the whole task at 4:00 PM (`LastTaskResult 267014`). Both are fixed. The walk now retries a page up to 4 times with 20 s / 60 s / 120 s backoff, logs the products call's OWN status, always disconnects and exits explicitly. The 4:04 PM re-run completed both: **Blazers 203 pages / 6,031 listings / 1,068 editions in 15.9 min; Detroit 35 / 1,020 / 172 in 2.9 min.** On it, Detroit p28 answered **HTTP 429, Cloudflare "Just a moment…"**, and the 20 s backoff recovered it. That throttle is the Blazers p15 cause.

| Piece | What |
|---|---|
| `scripts/panini-team-walk.mjs` | Playwright walk of one team's grid; reads the SPA's own `products` responses (never replays a signed request); flushes every 10 pages; logs HTTP status + title when a page gives no products answer |
| `app/api/cron/panini-team-walk` | bearer-guarded receiver: `heartbeat` / `ingest` / `finish`; a failed or count-less write is a non-2xx |
| `panini_team_listings` | staging, one row per listed NFT (sku); `franchise_keys` like `NBA:blazers`, `unmapped_teams` for what did not map (MLB LA/NY/Chicago) |
| `panini_team_aliases` + `panini_resolve_team_keys` | Panini `team` → teams_master; two-team cards map to both |
| `panini_team_listings_ingest` | upsert; retires listings a walk no longer saw **only when the walk was complete** (ended on an empty page and every flush landed) |
| `panini_team_listing_franchise_summary` | operator read-back: active listings / editions / min ask per franchise |

All service-role only; **nothing on the site reads it**. `pipeline_runs`: `panini-team-walk` (+ `-heartbeat` before each target). ⚠ The first two rows under that name (2026-09-24 7:32 AM PT, ok=false, "no readable products response") are the GitHub Actions attempt, not the laptop arm.

**Not done, on purpose:** no `league_collections` row for Panini yet (a hub panel reads `get_team_detail`, and Panini NBA/MLB is not in `editions`); no pricing (listings are asks, not FMV); no other teams (widen `PANINI_TEAM_TARGETS` once the pilot's numbers are read).

**Next:** read two or three more daily runs (watch for backoff lines and any `after 4 attempts` failure) → widen. **Sizing (measured, not guessed):** Blazers-sized teams take ~16 min, so all 30 NBA teams ≈ 8 h. The walk shares `RPC Panini Ingest`'s **2 h ExecutionTimeLimit** with the ~75 min soccer runner, so ≈ 2 teams fit per daily pass. Widening beyond that wants either a rotation (a few teams/day off a cursor) or its OWN scheduled task at an hour the soccer runner is idle (both drive the same debug Chrome, so never overlapping) → decide how Panini NBA prices are judged against the accuracy gate → bridge into `editions` and flip `league_collections`.

## Revert

- App: revert the commit (message starts `feat(teams): franchise hubs`).
- DB: `DROP FUNCTION public.get_franchise_hub(text, text);` restore the two pre-image bodies below; `DROP TABLE public.league_collections;` `DELETE FROM public.teams_master WHERE league = 'MLB';` (`league_t` keeps `MLB` — enum values cannot be dropped; an unused value is inert.) ⚠ Delete MLB rows from `user_favorite_teams` first if anyone has followed an MLB team.

### Pre-image: `get_my_fan_teams()` (before 2026-09-23)

```sql
CREATE OR REPLACE FUNCTION public.get_my_fan_teams()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(to_jsonb(t.*) ORDER BY t.is_primary DESC, t.league, t.team_name), '[]'::jsonb)
  FROM (
    SELECT uft.league::text AS league,
           CASE uft.league WHEN 'NBA' THEN 'nba_top_shot' WHEN 'WNBA' THEN 'nba_top_shot'
                           WHEN 'NFL' THEN 'nfl_all_day' WHEN 'LALIGA' THEN 'laliga_golazos' END AS collection_slug,
           CASE uft.league WHEN 'NBA' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                           WHEN 'WNBA' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                           WHEN 'NFL' THEN 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
                           WHEN 'LALIGA' THEN '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid END AS collection_id,
           tm.team_name,
           trim(both '-' from regexp_replace(lower(trim(tm.team_name)),'[^a-z0-9]+','-','g')) AS route_slug,
           tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id,
           uft.is_primary
    FROM user_favorite_teams uft
    JOIN teams_master tm ON tm.league = uft.league AND tm.slug = uft.team_slug
    WHERE uft.user_id = auth.uid()
  ) t;
$function$;
```

### Pre-image: `get_teams_for_league(league_t)` (before 2026-09-23)

```sql
CREATE OR REPLACE FUNCTION public.get_teams_for_league(p_league league_t)
 RETURNS TABLE(slug text, team_name text, abbreviation text, external_id text, primary_color text, secondary_color text, has_moments boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    tm.slug, tm.team_name, tm.abbreviation, tm.external_id,
    tm.primary_color, tm.secondary_color,
    CASE
      WHEN tm.league IN ('NBA','WNBA') THEN (
        EXISTS (SELECT 1 FROM badge_editions be
                WHERE be.team_nba_id = tm.external_id)
        OR EXISTS (SELECT 1 FROM editions e
                   JOIN collections c ON c.id = e.collection_id
                   WHERE c.slug = 'nba_top_shot' AND e.team_name = tm.team_name)
      )
      WHEN tm.league = 'NFL' THEN
        EXISTS (SELECT 1 FROM editions e
                JOIN collections c ON c.id = e.collection_id
                WHERE c.slug = 'nfl_all_day' AND e.team_name = tm.team_name)
      WHEN tm.league = 'LALIGA' THEN
        EXISTS (SELECT 1 FROM editions e
                JOIN collections c ON c.id = e.collection_id
                WHERE c.slug = 'laliga_golazos' AND e.team_name = tm.team_name)
      ELSE false
    END AS has_moments
  FROM teams_master tm
  WHERE tm.league = p_league AND tm.active = true
  ORDER BY tm.display_order, tm.team_name;
$function$;
```
