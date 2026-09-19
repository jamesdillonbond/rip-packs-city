-- P1 BRIDGE, STEP 0 — the mapping, executable and read-only. 2026-09-19 (Cowork cloud, Trevor present).
--
-- #64 decided on 2026-09-06 that the WC Prizm plane IS the Panini collection. P1 is the bridge:
-- panini_editions / panini_fmv_snapshots -> editions / fmv_snapshots. This migration WRITES NO
-- ROWS INTO EITHER and publishes nothing. It exists so the mapping is a thing that can be run and
-- diffed rather than a paragraph in a doc, and so the pre-flip gaps below are counted rather than
-- discovered during the flip.
--
-- ⛔ THE BRIDGE MUST NOT BE EXECUTED YET, and the reason is measured, not cautious. As of today
-- 1,265 of 5,072 editions (24.9%) have not been walked in 45+ days (p50 age 276 h, p90 1,384 h).
-- Writing those into the SHARED schema puts them into every cross-collection rollup, where they
-- are indistinguishable from a live price. Trevor's standing gate (docs/strategy/roadmap-2026-08-03.md)
-- is accuracy before exposure. EXIT CONDITION for step 1: pct_editions_stale_45d (published by
-- panini_coverage_summary since 20260919172027) at or near 0 and holding for a full week after the
-- stalest-first walk lands. FALSIFIER: if it does not fall, the walk fix did not work and the
-- bridge is not the next question.
--
-- WHAT THE MAPPING SETTLED (measured, so nobody re-derives it):
--   * tier and confidence are ALREADY the shared enums — panini_editions.tier is `tier_type` and
--     panini_fmv_snapshots.confidence is `fmv_confidence`, the same types editions/fmv_snapshots
--     use. No mapping table is needed; an earlier estimate assumed one.
--   * external_id is the psku and is UNIQUE across all 5,072 rows, so it is a sound natural key.
--     It does NOT match Top Shot's `^[0-9]+:[0-9]+(::[0-9]+)?$` canonical predicate — correct, and
--     every canonical filter in this repo is Top-Shot-scoped, but check before reusing one.
--   * Source completeness is total on the columns that matter: 0 nulls in player_name, set_name,
--     tier, mint_cap. 32 rows lack `nation`, 4 lack a thumbnail.
--   * All 58,244 panini_fmv_snapshots rows fall in 2026, so the bridge touches ONE partition
--     (fmv_snapshots_2026) and needs no partition work.
--
-- FOUR GAPS THIS VIEW DELIBERATELY DOES NOT PAPER OVER — each is a pre-flip decision, not a TODO:
--   1. `collections.chain` for panini_blockchain reads 'ethereum'. That describes the OpenSea
--      bridge plane, which #64 did NOT choose. The WC Prizm plane is a private Sawtooth chain.
--      `collection_chains` is the canonical chain join, so every bridged row would be labelled
--      Ethereum on every surface that reads it. Fix the registry row in the same migration that
--      writes the first edition, or not at all.
--   2. set_id / player_id stay NULL: no `sets` or `players` rows exist for Panini's 62 sets and
--      657 players. Shared set/player surfaces therefore render empty for Panini until those are
--      created. Naming it because an empty set page reads as "no cards", which is false.
--   3. team_name stays NULL even though panini_editions.nation is populated. A NATION IS NOT A
--      TEAM. Mapping it would put "Brazil" in a column every other collection fills with a club
--      or franchise, and the surfaces that render it say "Team".
--   4. edition_kind falls to its 'LE' default. Every WC Prizm card carries a mint_cap, so LE is
--      right — recorded so it is a decision on the record rather than an accident of the default.
--
-- REVERT (exact): drop view public.panini_bridge_candidate_fmv; drop view public.panini_bridge_candidate_editions;
-- Not a function: no anon-exec marker applies.

create or replace view public.panini_bridge_candidate_editions as
select
  pe.external_id::varchar                              as external_id,
  'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid         as collection_id,
  'panini_blockchain'::text                            as collection,
  pe.player_name                                       as player_name,
  pe.set_name                                          as set_name,
  pe.tier                                              as tier,
  pe.mint_cap                                          as circulation_count,
  pe.thumbnail_url                                     as thumbnail_url,
  pe.video_url                                         as video_url,
  pe.first_minted_at                                   as first_minted_at,
  null::uuid                                           as set_id,      -- gap 2
  null::uuid                                           as player_id,   -- gap 2
  null::text                                           as team_name,   -- gap 3 (pe.nation is a NATION)
  -- Carried so a reviewer can see the freshness of each candidate row BEFORE it is written.
  pe.last_seen_at                                      as source_last_seen_at,
  (pe.last_seen_at <= now() - interval '45 days')      as source_is_stale_45d
from public.panini_editions pe;

create or replace view public.panini_bridge_candidate_fmv as
select
  pf.edition_id                                        as source_edition_id,  -- text psku, NOT a uuid
  'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid         as collection_id,
  'panini_blockchain'::text                            as collection,
  pf.fmv_usd                                           as fmv_usd,
  pf.confidence                                        as confidence,
  pf.algo_version                                      as algo_version,
  pf.computed_at                                       as computed_at
from public.panini_fmv_snapshots pf;

revoke all on public.panini_bridge_candidate_editions from anon, authenticated;
revoke all on public.panini_bridge_candidate_fmv from anon, authenticated;
grant select on public.panini_bridge_candidate_editions to service_role;
grant select on public.panini_bridge_candidate_fmv to service_role;

comment on view public.panini_bridge_candidate_editions is
  'P1 bridge step 0 — the rows a panini_editions -> editions bridge WOULD write. Writes nothing, published nowhere. source_is_stale_45d is the gate: do not execute the bridge while a quarter of these are true. See the migration header for the four pre-flip gaps (collections.chain says ethereum; no sets/players rows; nation is not a team; edition_kind defaults to LE).';
comment on view public.panini_bridge_candidate_fmv is
  'P1 bridge step 0 — the rows a panini_fmv_snapshots -> fmv_snapshots bridge WOULD write. source_edition_id is the TEXT psku and must be resolved to the new editions.id uuid at write time; the editions rows therefore have to land first. All 58,244 source rows are in 2026, so one partition.';