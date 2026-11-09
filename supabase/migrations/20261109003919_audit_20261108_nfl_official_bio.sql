-- audit_20261108_nfl_official_bio
--
-- Panini football players ESPN cannot identify get date of birth and college from NFL.com's own player
-- pages (JSON-LD Person birthDate + alumniOf), 2026-11-08 (Trevor: "Do it all and continue to fill the
-- gaps"). Panini cards carry no team, so identity is UNIQUENESS IN THE NFL'S OWN REGISTER: the page
-- nfl.com/players/<slug>/ exists, states the name, and no namesake page <slug>-2 … -5 exists; AND the
-- ESPN box-score crosswalk has no verdict on the key (its ambiguous / family_ambiguous holds back Josh
-- Allen, Lamar Jackson, David Johnson, Chandler Jones, A.J. Green, Frank Gore, Jason Taylor, RG3,
-- Byron Murphy II — namesakes or father/son); head-coach names (Andy Reid, Bill Parcells, Jimmy
-- Johnson …) are never matched to a player page (coach Jimmy Johnson vs HOF CB Jimmy Johnson).
-- 46 published (Walter Payton, Jack Lambert, Bob Lilly, Brian Sipe, Elvin Bethea …). NFL.com states no
-- birthplace (its "Hometown" is not a place of birth and is not used).
-- Fetched once, 1 req/s, by scripts/bio/nfl-player-pages.py; snapshot
-- docs/research/nfl-player-pages-2026-11-08.json, loaded md5-checked via pg_net.
--
-- Revert: delete from public.player_official_bio where source = 'nfl.com'; restore the source CHECK
--   without 'nfl.com'.

alter table public.player_official_bio drop constraint player_official_bio_source_check;
alter table public.player_official_bio add constraint player_official_bio_source_check
  check (source in ('ufc.com', 'laliga.com', 'realmadrid.com', 'fcbarcelona.com', 'mlb.com', 'nfl.com'));
