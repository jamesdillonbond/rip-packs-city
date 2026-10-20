# Autographed Moments on NBA Top Shot and NFL All Day — census 2026-10-19

**Measured 2026-10-19 ~7:00–7:30 PM PT. Dated sample: re-derive before quoting.**

## The source of truth: Atlas `autographedAt`

Dapper's Atlas `EditionService/SearchEditions` (and `GetEdition`) returns, per edition:

- `autographedAt` — a timestamp on signed editions, `null` otherwise. **This is the flag.**
- `assets[]` entries named `autograph-image` / `autograph-video` on signed editions (seen on `GetEdition`; `SearchEditions` omits them, so do not test for them there).
- `activePartnerAthlete` / `pastPartnerAthlete` — a different concept: only 4 players read `true` (Coward, Flagg, Jalen Johnson, Siakam). **Not the signer list.**

Neither the Top Shot GQL `tags` that `badge_editions` syncs, nor Dapper's pack `original_counts_by_tier.autograph` (0 even on packs that held signed Moments), nor any set or parallel name carries it. Prices cannot recover it either. On Series 8 Rookie Debut, the median Hardcourt/Blockchain price ratio is 2.97× for signed players against 2.11× for unsigned, but the ranges overlap (1.8–4.4 vs 1.5–3.5).

Reach: `pg_net` + `public.atlas_market_headers(product)` from the database (`limit` is capped at 100; about 30 % of bursts of 10 are Cloudflare 403s, so 4 every 15 s were used). `public-api.nbatopshot.com` answers the database with Cloudflare `1033`, and this sandbox reaches no Dapper host at all.

## Census (complete: 14,450 nba + 5,835 nfl rows = Atlas `totalCount`)

Raw rows: `public.audit_20261019_autograph_editions` (RLS on). **Every signed edition joins to an RPC edition**: Top Shot 236/236 via `topshot_atlas_edition_map.atlas_edition_id`, All Day 226/226 via `editions.external_id`.

| | signed editions | signed Moments minted | players |
|---|---|---|---|
| NBA Top Shot | 236 | 4,197 | 69 |
| NFL All Day | 226 | 5,482 | 152 |

Only 55 of Top Shot's 236 sit in a set named "Signature …". 222 of All Day's 226 do.

### Top Shot — signed cells (set → parallel, signed / editions in the cell)

| series | set → parallel | serial | signed |
|---|---|---|---|
| 8 | Signature Series | 1/1 | 27 / 30 |
| 8 | Rookie Debut → Hardcourt | /50 | 27 / 61 |
| 8 | Origins → Jukebox | /10 | 18 / 30 |
| 8 | Rookie Revelation → Omega | 1/1 | 16 / 30 |
| 8 | Freshman Gems → Jukebox | /10 | 15 / 30 |
| 8 | WNBA Rookie Debut → Hardcourt | /50 | 15 / 48 |
| 8 | 2025 Rookie Ultimates | 1/1 | 13 / 26 |
| 8 | **Top Script** (Standard /44, Galactic /5, Omega 1/1) | — | 36 / 36 — every printing of 12 veterans |
| 8 | Fresh Gems → Jukebox | /10 | 12 / 20 |
| 7 | WNBA Rookie Debut 2025 – Signature Edition | /50 | 10 / 10 |
| 8 | WNBA Rookie Revelation → Omega | 1/1 | 9 / 15 |
| 7 | WNBA Rookie Revelation: Signature Edition | /10 | 9 / 9 |
| 7 | WNBA Fresh Gems: Signature Edition | /20 | 9 / 9 |
| 8 | WNBA Rookie Ultimate 2026 | 1/1 | 7 / 16 |
| 8 | Metallic Gold LE → Jukebox | /10 | 5 / 90 (Coward, Flagg, Queen, Knueppel, Edgecombe) |
| 8 | 2026 Playoff Premieres → Jukebox | /10 | 2 / 3 |
| 7 | 2025 WNBA Rookie Ultimates | 1/1 | 2 / 12 |
| 8 | WNBA Metallic Gold LE → Jukebox | /10 | 2 / 45 |
| 5 | The Anthology: Magic Johnson | /80 | 1 / 1 (signed 2022) |
| 5 | The Anthology: Larry Bird | /33 | 1 / 1 |

**Not signed:** Signature Style (/99, 12 WNBA editions; a pack description calls it "autographed", Atlas does not) · Season Rewind: Signature Victory · every Blockchain /99 · NBA Rookie Revelation Galactic.

### All Day — signed sets

Rookie Debut: Signature Edition /50 (45/45) · Metallic Gold LE Signature Edition /25 (85/85, smaller mints 3–14 on 15) · Holo Icon Signature Edition /15 (49/49, smaller mints on 9) · Regal Rookies Signature Edition /25 (20/20) · Rookie Revelation Signature Edition /15 (10/10) · Rookie Marquee Signature Edition 1/1 (11/12) · **Marquee (series 8) /10, 4 of 12** · Marquee Signature Edition 1/1 · Super Bowl LX Marquee Signature Edition 1/1.

**Not signed:** One to Remember · NFL Honors · Rookie Honors · every `(Parallel)` set.

## Implications

- **Within a set, signed is per player.** A rule such as "Hardcourt = signed" is false 34 times out of 61. Store the flag per edition, from Atlas, and refresh it: the newest `autographedAt` values (Signature Series) carry the census day's date (the stamps are date-granular), so signings land on editions that already exist.
- **The 2026-27 rule (a partner's scarcest parallel is signed; blog 10-14) is a forecast, not data.** Read Series 9 from Atlas as it mints.
- (At the census) `lib/sniper/feed-helpers.ts` "Auto" label had no upstream feeding it, and `lib/market-compute.ts`'s "autograph" confidence keyed on special serials — renamed `special-serial` in the build below.

## Built 2026-10-19 (same evening)

- **DB** (`20261020030228`): `editions.autographed_at` + `edition_autograph_checks` + the daily Atlas sweep (`autograph_sweep_tick`, pg_cron `rpc-autograph-sweep`, pipeline `autograph-sweep` on the cadence watchlist). Seeded from this census. Schema notes: [schema-truth.md](../reference/schema-truth.md) "Autographs".
- **Badges** (`20261020030510`, pinned): `get_edition_badges_unified` emits "Autographed" first → edition page, moment page, OG cards, trophy case and the Market **Badges** filter (via `market_edition_badges`). `badge_taxonomy` row `autographed` (`20261020031442`).
- **Sniper**: signed deals carry the `autograph` badge ("Auto"); new **AUTOGRAPHS ONLY** filter (Top Shot + All Day; `?autographOnly=true`). A failed autograph read degrades the board under that filter (`sourcesFailed: ["autographs"]`), never an empty "nothing signed" board. All Day rows are matched on player + set, claimed only when every edition of the pair is signed.
- **Wallet Collection tab**: "Autographed" pill (via `/api/badges`) + **✍ AUTOGRAPHS** toggle.
- **Concierge**: every edition row carries `autographed` — true / false (Atlas-verified unsigned, needs a check row) / null (not checked).
