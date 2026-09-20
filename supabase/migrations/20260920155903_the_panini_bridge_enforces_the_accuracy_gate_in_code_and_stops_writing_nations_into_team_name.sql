-- PANINI P1 BRIDGE — the accuracy gate becomes CODE, and `nation` stops being written
-- into `team_name`. 2026-09-20 ~9:0x AM PT (Claude Code cloud).
--
-- `sync_panini_editions_to_shared` has been shipped-but-inert since 2026-07-19 (Panini rows in
-- `editions` / `sets` / `players` are still 0 / 0 / 0, re-verified live immediately before this
-- migration). Two defects were found by reading its LIVE body rather than the docs about it.
--
-- ── 1. THE ACCURACY GATE WAS PROSE, NOT A GATE ────────────────────────────────────────────────
-- docs/strategy/panini-go-live-2026-09-19.md §4 orders step 1 (prove the walk fix) BEFORE step 2
-- (the bridge), and migration 20260919173527's header states the reason in ⛔ terms: writing
-- month-and-a-half-old prices into the SHARED schema makes them indistinguishable from live ones
-- in every cross-collection rollup. Trevor's standing gate (roadmap-2026-08-03.md) is accuracy
-- before exposure.
--
-- ⛔ NONE OF THAT WAS ENFORCED. The function's only `blocked` condition was slug collisions. The
-- staleness gate existed solely as a `note` STRING in the dry-run payload — "Live run is a
-- strategy decision … Read panini_coverage_summary first." A note is not a gate. On 2026-09-19,
-- `sync_panini_editions_to_shared(false)` would have written all 1,265 editions that had not been
-- re-priced in 45+ days straight into the shared catalogue, and nothing in the function would have
-- objected. This is the repo's own "a guard that documents itself instead of enforcing itself"
-- shape, and it sat directly under a header that said it must not happen.
--
-- ✅ The gate is now a precondition: the live branch REFUSES while `pct_editions_stale_45d`
-- exceeds MAX_STALE_PCT (1.0 — the exit condition the go-live doc states), and the dry run
-- REPORTS it instead of only mentioning it. Measured today: 0.1% (3 of 5,074), so the gate is
-- currently OPEN on this reading — it is the 7-day hold, not this threshold, that still says wait.
--
-- ⚠ IT FAILS CLOSED, deliberately, and that is the half most easily got wrong. A gate that reads
-- its own instrument with `coalesce(..., 0)` passes loudest exactly when the read broke — the
-- repo's `?? 0` fabricated-value shape. If `panini_coverage_summary` yields no row, or a NULL
-- percentage, or a total of zero editions, the function RAISES rather than concluding "not stale".
-- A failed read must never render as permission.
--
-- ⚠ SIGNATURE DELIBERATELY UNCHANGED — `(p_dry_run boolean DEFAULT true)`. Adding a threshold
-- parameter would have created an OVERLOAD, not a replacement: the old one-argument function would
-- still exist and still be what every existing caller resolves to, so the "fix" would ship beside
-- the unfixed function it replaced. Same signature also preserves the ACL (verified before this
-- migration: EXECUTE is postgres + service_role only; anon and authenticated are false). To move
-- the threshold, edit MAX_STALE_PCT below in a new migration — that friction is intentional for a
-- gate whose entire purpose is not to be waved through.
--
-- ── 2. `team_name` WAS BEING FED `panini_editions.nation` ──────────────────────────────────────
-- The go-live doc's gap 3 records the decision: "team_name stays NULL even though
-- panini_editions.nation is populated. A NATION IS NOT A TEAM." The read-only candidate view
-- (20260919173527) honours it — `null::text as team_name`. **The live function did not**: it
-- mapped `pa.nation` into `team_name`. The doc described the view and never checked the executable.
--
-- 📏 And the column is worse than the doc's framing. Measured live 2026-09-20: 3,535 rows carry a
-- `nation`, across 85 distinct values, which include HOST CITIES ("Dallas", "Seattle", "Vancouver",
-- "San Francisco Bay Area", "New York New Jersey", "Monterrey"), the governing body itself
-- ("FIFA"), and doubled dual-card values ("Brazil | Brazil", "Algeria | Algeria"). `team_name`
-- feeds the `/[collection]/team/[slug]` route family, `/my-teams`, and the team OG card — so the
-- live function would have minted team pages for a city and for FIFA. Now NULL, per the decision.
-- The ON CONFLICT arm keeps `coalesce(excluded.team_name, editions.team_name)`, so a NULL never
-- erases a value some later, deliberate mapping puts there.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────────────────────────────────────
-- It does NOT run the bridge and writes no shared row. Panini stays 0 / 0 / 0. It does not touch
-- `collections.chain` — measured 2026-09-20, `collection_chains` and `collections.chain` have ZERO
-- consumers (0 of 176 views/matviews, 0 pg_proc, 0 code paths), so the go-live doc's gap 1 was
-- pointed at the wrong artifact; the real Ethereum defect was `dbChain` in lib/collections.ts and
-- shipped separately today. Gap 2 (no sets/players rows) is what this function CREATES on a live
-- run, so it stays open by design. Gap 4 (`edition_kind` defaults to LE) is correct and unchanged.
--
-- ⚠ NOT CLAIMED: that the source catalogue is now trustworthy. `pct_trustworthy` is 35.2% and
-- measures listing-gated DISCOVERY, a different problem this gate cannot see. The 2026-07-19 parity
-- assessment's objection — bridging pushes a partial index into shared surfaces with nowhere to
-- disclose it — is EDITORIAL, still open, and is not what this threshold answers.
--
-- ── anon-exec decision (required by __tests__/migration-new-function-states-its-anon-exec-decision) ──
-- anon-exec: already-revoked, NOT intentional — sync_panini_editions_to_shared is not anon-callable
-- and must never be. This migration deliberately adds NO `REVOKE`, because `CREATE OR REPLACE
-- FUNCTION` does not reset a function's ACL: the existing grant is already correct, so a revoke
-- here would be a statement about production that this body-only rewrite has no business making.
-- Verified on BOTH sides of the apply, with has_function_privilege rather than acl text:
-- anon=false, authenticated=false, service_role=true, postgres=true. The post-apply block below
-- asserts all four, so a future replace that silently widened the ACL fails this migration's own
-- check rather than being noticed later by the drift guard.
--
-- REVERT (exact): re-apply the body from migration
-- 20260719_audit_20260719_sync_panini_editions_to_shared_dryrun_default (and its _subject_classifier
-- follow-up), which is the text whose md5 is gated below: 3cb42e291afc3811c9d82822ea66ee0d.
-- ⚠ Reverting restores BOTH defects — the ungated write and the nation→team_name mapping.

-- ── md5 gate: refuse if the live body is not the one this migration was written against ────────
do $gate$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sync_panini_editions_to_shared';

  if v_md5 is null then
    raise exception 'sync_panini_editions_to_shared not found -- refusing to CREATE OR REPLACE blind';
  end if;
  if v_md5 <> '3cb42e291afc3811c9d82822ea66ee0d' then
    raise exception 'live body md5 % does not match the text this migration was written against (3cb42e29...) -- another session changed it; re-read the live object first', v_md5;
  end if;
end
$gate$;

create or replace function public.sync_panini_editions_to_shared(p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- The exit condition from docs/strategy/panini-go-live-2026-09-19.md §4 step 1, as a number the
  -- function enforces rather than a sentence it quotes. Moving it is a new migration, on purpose.
  MAX_STALE_PCT constant numeric := 1.0;

  v_cid uuid;
  v_slug text;
  v_src int := 0;
  v_set_collisions int := 0;
  v_player_collisions int := 0;
  v_sets_target int := 0;
  v_players_target int := 0;
  v_ed_existing int := 0;
  v_rows_multi int := 0;
  v_rows_entity int := 0;
  v_sets_written int := 0;
  v_players_written int := 0;
  v_ed_written int := 0;
  v_unlinked int := 0;
  v_stale_pct numeric;
  v_stale_n bigint;
  v_cov_total bigint;
  v_stale_blocked boolean;
  v_collision_blocked boolean;
begin
  select id, slug into v_cid, v_slug from collections where slug = 'panini_blockchain';
  if v_cid is null then
    raise exception 'sync_panini_editions_to_shared: collections row slug=panini_blockchain not found';
  end if;

  -- ACCURACY GATE, read FAIL-CLOSED. Three ways this read can fail to mean what it says, and all
  -- three must refuse rather than permit: no row at all, a NULL percentage, or a zero denominator
  -- (a percentage over no editions is not 0% stale, it is no measurement).
  select pct_editions_stale_45d, editions_stale_45d, total_editions
    into v_stale_pct, v_stale_n, v_cov_total
  from panini_coverage_summary;

  if not found or v_stale_pct is null or v_cov_total is null or v_cov_total = 0 then
    raise exception 'sync_panini_editions_to_shared: refusing to proceed -- panini_coverage_summary did not yield a usable staleness reading (pct=%, total=%). A failed read is not permission.',
      v_stale_pct, v_cov_total;
  end if;

  v_stale_blocked := (v_stale_pct > MAX_STALE_PCT);

  select count(*) into v_src from panini_editions;
  select count(*) into v_rows_multi from panini_editions where btrim(player_name) like '%|%';
  select count(*) into v_rows_entity from panini_editions
   where btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%';

  select count(*) into v_set_collisions from (
    select btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
    group by 1 having count(distinct set_name) > 1
  ) z;

  select count(*) into v_player_collisions from (
    select btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
    group by 1 having count(distinct player_name) > 1
  ) z;

  v_collision_blocked := (v_set_collisions > 0 or v_player_collisions > 0);

  select count(distinct set_name) into v_sets_target from panini_editions
   where nullif(btrim(coalesce(set_name,'')),'') is not null;

  select count(distinct btrim(player_name)) into v_players_target from panini_editions
   where nullif(btrim(coalesce(player_name,'')),'') is not null
     and btrim(player_name) not like '%|%'
     and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%');

  select count(*) into v_ed_existing
  from editions e where e.collection_id = v_cid
    and e.external_id in (select pa.external_id from panini_editions pa);

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true,
      'collection_id', v_cid,
      'source_panini_editions', v_src,
      'would_upsert_sets', v_sets_target,
      'would_upsert_players', v_players_target,
      'would_insert_editions', v_src - v_ed_existing,
      'would_update_editions', v_ed_existing,
      'rows_dual_player_card', v_rows_multi,
      'rows_entity_card', v_rows_entity,
      'rows_left_without_player_link', v_rows_multi + v_rows_entity,
      'set_slug_collisions', v_set_collisions,
      'player_slug_collisions', v_player_collisions,
      -- The staleness gate REPORTS here and RAISES below. Both halves read the same variables, so
      -- a dry run cannot say "clear" about a live run that would refuse.
      'source_pct_stale_45d', v_stale_pct,
      'source_editions_stale_45d', v_stale_n,
      'max_stale_pct', MAX_STALE_PCT,
      'blocked_by_staleness', v_stale_blocked,
      'blocked_by_collisions', v_collision_blocked,
      'blocked', (v_stale_blocked or v_collision_blocked),
      'note', 'The staleness threshold is enforced, not advisory. It does NOT answer the editorial question: a live run makes a listing-gated index (pct_trustworthy ~35%) a full citizen of the shared catalog, and no threshold here measures that.'
    );
  end if;

  if v_stale_blocked then
    -- No literal percent signs in this string. In a plpgsql `raise`, `%%%` is scanned left to
    -- right as `%%` (literal) + `%` (placeholder), so it renders the sign BEFORE the value.
    raise exception 'sync_panini_editions_to_shared: refusing to write -- stale share is % percent (% of % editions not re-priced in 45+ days), above the ceiling of % percent. Bridging now puts stale prices into every cross-collection rollup, where nothing can tell them from live ones.',
      v_stale_pct, v_stale_n, v_cov_total, MAX_STALE_PCT;
  end if;

  if v_collision_blocked then
    raise exception 'sync_panini_editions_to_shared: refusing to write -- % set and % player slug collisions would merge distinct entities',
      v_set_collisions, v_player_collisions;
  end if;

  with s as (
    select distinct
      'panini-' || btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
      btrim(set_name) as nm
    from panini_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
  )
  insert into sets (external_id, collection_id, name, created_at, updated_at)
  select ext, v_cid, nm, now(), now() from s
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_sets_written = row_count;

  with p as (
    select distinct
      'panini-' || btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
      btrim(player_name) as nm
    from panini_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
  )
  insert into players (external_id, collection_id, name, collection, created_at, updated_at)
  select ext, v_cid, nm, v_slug, now(), now() from p
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_players_written = row_count;

  insert into editions (
    external_id, collection_id, name, player_id, set_id, tier, circulation_count,
    thumbnail_url, video_url, first_minted_at, collection, player_name, set_name,
    team_name, created_at, updated_at
  )
  select
    pa.external_id,
    v_cid,
    concat_ws(' - ', nullif(btrim(coalesce(pa.player_name,'')),''), nullif(btrim(coalesce(pa.set_name,'')),'')),
    pl.id,
    st.id,
    pa.tier,
    pa.mint_cap,
    pa.thumbnail_url,
    pa.video_url,
    pa.first_minted_at,
    v_slug,
    pa.player_name,
    pa.set_name,
    -- This position USED TO carry the source nation column. A NATION IS NOT A TEAM (go-live doc
    -- gap 3), and that column is not even purely nations: 85 distinct values including host cities
    -- ("Dallas", "Vancouver", "San Francisco Bay Area"), "FIFA", and doubled dual-card values
    -- ("Brazil | Brazil"). team_name feeds /[collection]/team/[slug], /my-teams and the team OG
    -- card. (Deliberately not spelling the old expression here: the post-apply assertion greps the
    -- installed body for it, and pg_get_functiondef includes comments.)
    null::text,
    now(),
    now()
  from panini_editions pa
  left join players pl
    on btrim(pa.player_name) not like '%|%'
   and not (btrim(pa.set_name) ilike 'Team Badges%' or btrim(pa.set_name) ilike 'World Cup Posters%')
   and pl.external_id = 'panini-' || btrim(regexp_replace(lower(btrim(pa.player_name)), '[^a-z0-9]+', '-', 'g'), '-')
  left join sets st
    on st.external_id = 'panini-' || btrim(regexp_replace(lower(btrim(pa.set_name)), '[^a-z0-9]+', '-', 'g'), '-')
  on conflict (external_id, collection_id) do update set
    name              = excluded.name,
    player_id         = coalesce(excluded.player_id, editions.player_id),
    set_id            = coalesce(excluded.set_id, editions.set_id),
    tier              = excluded.tier,
    circulation_count = excluded.circulation_count,
    thumbnail_url     = coalesce(excluded.thumbnail_url, editions.thumbnail_url),
    video_url         = coalesce(excluded.video_url, editions.video_url),
    player_name       = excluded.player_name,
    set_name          = excluded.set_name,
    -- excluded.team_name is now always NULL, so this never erases a value a later, deliberate
    -- team mapping puts there.
    team_name         = coalesce(excluded.team_name, editions.team_name),
    updated_at        = now();
  get diagnostics v_ed_written = row_count;

  select count(*) into v_unlinked
  from editions e where e.collection_id = v_cid and e.player_id is null;

  return jsonb_build_object(
    'dry_run', false,
    'collection_id', v_cid,
    'sets_upserted', v_sets_written,
    'players_upserted', v_players_written,
    'editions_upserted', v_ed_written,
    'editions_without_player_link', v_unlinked,
    'expected_without_player_link', v_rows_multi + v_rows_entity,
    'source_pct_stale_45d_at_write', v_stale_pct
  );
end;
$function$;

comment on function public.sync_panini_editions_to_shared(boolean) is
  'P1 Panini bridge, dry-run by default. ENFORCES the accuracy gate in code: refuses to write while panini_coverage_summary.pct_editions_stale_45d exceeds 1.0, and fails CLOSED if that reading is missing/NULL/over a zero denominator. Writes NULL into team_name -- panini_editions.nation holds nations, host cities and "FIFA", and a nation is not a team. The threshold does NOT settle the editorial question (a listing-gated ~35%-trustworthy index becoming a full citizen of the shared catalog).';

-- ── post-apply assertions ─────────────────────────────────────────────────────────────────────
do $verify$
declare
  v_def text;
  v_panini_editions int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sync_panini_editions_to_shared';

  if v_def !~ 'MAX_STALE_PCT' then
    raise exception 'post-apply: the staleness gate is absent from the installed body';
  end if;
  -- Negative: the old expression is gone from the installed body.
  if v_def ~ 'pa\.nation' then
    raise exception 'post-apply: the source nation column is still mapped into team_name';
  end if;
  -- Positive control for that negative — a grep for an ABSENCE passes just as well when the whole
  -- INSERT vanished or the name changed. This pins that the team_name slot is present and NULL.
  if v_def !~ 'null::text,\s*\n\s*now\(\),' then
    raise exception 'post-apply: the team_name column position is not the expected NULL literal';
  end if;

  -- The ACL must have survived the same-signature replace.
  if has_function_privilege('anon', 'public.sync_panini_editions_to_shared(boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sync_panini_editions_to_shared(boolean)', 'EXECUTE') then
    raise exception 'post-apply: anon/authenticated can EXECUTE the bridge -- revoke before proceeding';
  end if;
  if not has_function_privilege('service_role', 'public.sync_panini_editions_to_shared(boolean)', 'EXECUTE') then
    raise exception 'post-apply: service_role LOST EXECUTE on the bridge';
  end if;

  -- And the bridge must still be inert: this migration writes no shared row.
  select count(*) into v_panini_editions
  from editions where collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  if v_panini_editions <> 0 then
    raise exception 'post-apply: expected the bridge to still be inert, found % panini rows in editions', v_panini_editions;
  end if;
end
$verify$;
