-- audit_20261106_multiple_trophy_cases_and_challenges
--
-- Multiple trophy cases per collector, and CHALLENGE cases whose rules RPC sets
-- (first one: "Dame Time" — favorite Damian Lillard Top Shot Moments + Panini
-- cards). Trevor, 2026-11-06.
--
-- MODEL. `trophy_moments` stays the one table of pinned trophies; a new nullable
-- `case_id` says which case a row belongs to. NULL = the collector's MAIN case —
-- every one of the 65 rows that exist today, unchanged. A non-null case_id points
-- at `trophy_cases`, which is either a named case (challenge_id NULL) or a
-- collector's entry into a `trophy_challenges` row (one entry per challenge).
--
-- ⚠ THE TRAP THIS SHAPE CREATES, and where each half is closed. Every reader and
-- writer that matched on (user_id, slot) alone would now span EVERY case — an
-- unpin of main-case slot 1 would also delete the challenge entry's slot 1. The
-- DB half is closed here (slab read, reorder, milestones trigger, campaign view
-- all scope by case_id); the route half ships in the same change
-- (`.is("case_id", null)` on the main-case GET/PATCH/DELETE).
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION, so it can be applied BEFORE the code
-- deploys: the old `(user_id, slot)` unique constraint is KEPT here (the deployed
-- route upserts `onConflict: "user_id,slot"`); both new function parameters
-- default to NULL = main case, so the deployed 1-/2-arg calls resolve unchanged.
-- The old constraint is dropped by the follow-up migration
-- `audit_20261106_trophy_moments_drop_user_slot_key`, after the deploy.
--
-- WRITES. Case rows are written ONLY by the service-role route, which verifies
-- ownership and the challenge's rules server-side. The authenticated RLS
-- INSERT/UPDATE policies now require `case_id IS NULL`, so a browser client cannot
-- write a row into any case (its own or someone else's) and skip those checks. A
-- BEFORE trigger independently refuses a case_id owned by another user.
--
-- Revert (after the follow-up has also been reverted):
--   drop function if exists public.get_trophy_challenge_entries(text, int);
--   drop function if exists public.get_trophy_cases_by_username(text);
--   drop function if exists public.get_trophy_cases_for_user(uuid);
--   drop function public.get_trophy_slab_data(uuid, uuid);  -- then re-run the body of
--     20260930060000_audit_20260929_trophy_slab_exposes_jersey_number_for_special_serial_marks.sql
--     and: revoke execute on function public.get_trophy_slab_data(uuid) from public, anon, authenticated;
--          grant execute on function public.get_trophy_slab_data(uuid) to service_role;
--   drop function public.reorder_trophy_slots(uuid, bigint[], uuid);  -- then recreate the
--     2-arg body quoted in the pre-image comment of section 6, service_role only.
--   restore trophy_case_milestones_track from 20260927154432 (section 1);
--   restore trophy_case_campaign_users from 20260927154432 (section 4);
--   alter policy trophy_moments_insert_own on public.trophy_moments with check (user_id = (select auth.uid()));
--   alter policy trophy_moments_update_own on public.trophy_moments using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
--   drop trigger trophy_moments_case_owner_check on public.trophy_moments; drop function public.trophy_moments_case_owner_check();
--   delete from public.trophy_moments where case_id is not null;
--   alter table public.trophy_moments drop constraint trophy_moments_user_case_slot_key;
--   alter table public.trophy_moments drop column case_id;
--   drop table public.trophy_cases; drop table public.trophy_challenges;

-- ── 1. Challenges ──────────────────────────────────────────────────────────

create table public.trophy_challenges (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  title       text not null check (length(btrim(title)) between 1 and 80),
  tagline     text check (tagline is null or length(tagline) <= 160),
  description text check (description is null or length(description) <= 1000),
  -- Server-enforced pin rules. Keys read by app/api/profile/trophy/route.ts
  -- (lib/trophy/challenge-rules.ts):
  --   player_names     text[]  — the resolved edition's player must be one of these
  --   collection_slugs text[]  — collections.slug values a pin may come from
  --   require_owned    bool    — the Moment/card must be in the collector's indexed holdings
  rules       jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

comment on table public.trophy_challenges is
  'Themed trophy-case challenges. A collector enters by creating a trophy_cases row with this challenge_id; each pin into it is checked against `rules` by the service-role trophy route.';

alter table public.trophy_challenges enable row level security;
revoke all on public.trophy_challenges from anon, authenticated;
grant all on public.trophy_challenges to service_role;

-- ── 2. Cases ───────────────────────────────────────────────────────────────

create table public.trophy_cases (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 40),
  challenge_id    uuid references public.trophy_challenges(id) on delete restrict,
  created_at      timestamptz not null default now(),
  -- Set-once, stamped by trophy_case_milestones_track (section 5): first pin, and
  -- the first time all 6 slots were filled. Same contract as trophy_case_milestones.
  first_pinned_at timestamptz,
  completed_at    timestamptz,
  -- One entry per challenge per collector. NULL challenge_id (named cases) is
  -- NULLS DISTINCT, so any number of those.
  constraint trophy_cases_user_challenge_key unique (user_id, challenge_id)
);

create index trophy_cases_user_id_idx on public.trophy_cases (user_id);
create index trophy_cases_challenge_id_idx on public.trophy_cases (challenge_id) where challenge_id is not null;

comment on table public.trophy_cases is
  'Additional trophy cases beyond the main one (trophy_moments.case_id IS NULL). challenge_id NULL = a named case; non-null = an entry in that challenge. Written only by the service-role routes.';

alter table public.trophy_cases enable row level security;
revoke all on public.trophy_cases from anon, authenticated;
grant all on public.trophy_cases to service_role;

-- ── 3. trophy_moments.case_id ──────────────────────────────────────────────

alter table public.trophy_moments
  add column case_id uuid references public.trophy_cases(id) on delete cascade;

comment on column public.trophy_moments.case_id is
  'NULL = the collector''s main trophy case. Otherwise the trophy_cases row this trophy is pinned in. Scope EVERY (user_id, slot) read/write by this column.';

-- One trophy per slot PER CASE. NULLS NOT DISTINCT makes the main case (NULL)
-- one case rather than an unlimited number of them, so the main-case upsert can
-- conflict on (user_id, case_id, slot). Verified on PG16 before shipping: a
-- NULL-case upsert lands on the existing row, and the old (user_id, slot) upsert
-- still works while both constraints exist.
alter table public.trophy_moments
  add constraint trophy_moments_user_case_slot_key unique nulls not distinct (user_id, case_id, slot);

create index trophy_moments_case_id_idx on public.trophy_moments (case_id) where case_id is not null;

-- A case_id must belong to the row's own user. SECDEF because an authenticated
-- RLS writer has no grant on trophy_cases; with case_id NULL it never reads it.
create or replace function public.trophy_moments_case_owner_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.case_id is not null then
    if not exists (
      select 1 from public.trophy_cases c
      where c.id = new.case_id and c.user_id = new.user_id
    ) then
      raise exception 'trophy case % does not belong to this user', new.case_id
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- anon-exec: revoked (trophy_moments_case_owner_check) — new SECDEF trigger fn; revoked FROM PUBLIC, anon, authenticated below in ONE statement.
revoke execute on function public.trophy_moments_case_owner_check() from public, anon, authenticated;
grant execute on function public.trophy_moments_case_owner_check() to postgres, service_role;

create trigger trophy_moments_case_owner_check
before insert or update of case_id, user_id on public.trophy_moments
for each row execute function public.trophy_moments_case_owner_check();

-- ── 4. RLS: browser clients may only write the MAIN case ───────────────────
-- Pre-images: insert_own WITH CHECK (user_id = (SELECT auth.uid()));
--             update_own USING/WITH CHECK (user_id = (SELECT auth.uid())).
-- Delete and select are unchanged (deleting your own row is safe in any case).

alter policy trophy_moments_insert_own on public.trophy_moments
  with check (user_id = (select auth.uid()) and case_id is null);
alter policy trophy_moments_update_own on public.trophy_moments
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and case_id is null);

-- ── 5. Milestones: the campaign counts the MAIN case only ──────────────────
-- Pre-image: 20260927154432 section 1. The main-case branch is unchanged except
-- that its slot count is scoped to case_id IS NULL — before this a challenge
-- entry's pins would have counted toward "completed the trophy case".

create or replace function public.trophy_case_milestones_track()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slots int;
begin
  if new.case_id is not null then
    select count(*) into v_slots
    from public.trophy_moments
    where case_id = new.case_id;

    update public.trophy_cases
       set first_pinned_at = coalesce(first_pinned_at, now()),
           completed_at    = case when completed_at is null and v_slots >= 6
                                  then now() else completed_at end
     where id = new.case_id;
    return null;
  end if;

  insert into public.trophy_case_milestones (user_id, started_at, started_at_source)
  values (new.user_id, now(), 'observed')
  on conflict (user_id) do nothing;

  select count(*) into v_slots
  from public.trophy_moments
  where user_id = new.user_id
    and case_id is null;

  if v_slots >= 6 then
    update public.trophy_case_milestones
       set completed_at = now(),
           completed_at_source = 'observed'
     where user_id = new.user_id
       and completed_at is null;
  end if;

  return null;
end;
$$;

-- anon-exec: unchanged (trophy_case_milestones_track) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.

create or replace view public.trophy_case_campaign_users
with (security_invoker = on) as
 SELECT m.user_id,
    (ia.user_id IS NOT NULL) AS is_internal,
    ia.reason AS internal_reason,
    m.started_at,
    m.started_at_source,
    m.completed_at,
    m.completed_at_source,
    COALESCE(s.current_slots, 0) AS current_slots,
    fp.created_at AS first_pin_event_at,
    "substring"(fp.referrer, 'utm_source=([^&]+)'::text) AS first_pin_utm_source,
    "substring"(fp.referrer, 'utm_medium=([^&]+)'::text) AS first_pin_utm_medium,
    "substring"(fp.referrer, 'utm_campaign=([^&]+)'::text) AS first_pin_utm_campaign,
    "substring"(fp.referrer, 'share_ref=([^&]+)'::text) AS first_pin_share_ref
   FROM (((trophy_case_milestones m
     LEFT JOIN internal_accounts ia ON ((ia.user_id = m.user_id)))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS current_slots
           FROM trophy_moments tm
          WHERE (tm.user_id = m.user_id) AND tm.case_id IS NULL) s ON (true))
     LEFT JOIN LATERAL ( SELECT fe.created_at,
            fe.referrer
           FROM funnel_events fe
          WHERE ((fe.user_id = m.user_id) AND (fe.event_type = 'trophy_pinned'::text))
          ORDER BY fe.created_at
         LIMIT 1) fp ON (true));

-- ── 6. reorder_trophy_slots gains p_case_id (DEFAULT NULL = main case) ──────
-- Pre-image (live prosrc 2026-11-06, never in a migration file before): the same
-- body with every `user_id = p_user_id` UNSCOPED by case and no case_id in the
-- re-insert — i.e. it would DELETE every case's rows and re-insert only the ones
-- listed. Signature change, so DROP + CREATE, and the ACL is restated: it was
-- service_role-only (has_function_privilege anon=false, authenticated=false).

drop function public.reorder_trophy_slots(uuid, bigint[]);

create or replace function public.reorder_trophy_slots(p_user_id uuid, p_ordered_ids bigint[], p_case_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_count int;
  v_owned int;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required';
  END IF;

  v_count := COALESCE(array_length(p_ordered_ids, 1), 0);
  IF v_count = 0 THEN
    RETURN;
  END IF;
  IF v_count > 6 THEN
    RAISE EXCEPTION 'too many slots: %', v_count;
  END IF;

  IF (SELECT count(DISTINCT x) FROM unnest(p_ordered_ids) AS x) <> v_count THEN
    RAISE EXCEPTION 'duplicate ids in requested order';
  END IF;

  SELECT count(*) INTO v_owned FROM trophy_moments
   WHERE user_id = p_user_id AND case_id IS NOT DISTINCT FROM p_case_id;
  IF v_owned <> v_count THEN
    RAISE EXCEPTION 'id set mismatch: caller owns % trophies, order lists %',
      v_owned, v_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_ordered_ids) AS x
    WHERE x NOT IN (SELECT tm.id FROM trophy_moments tm
                     WHERE tm.user_id = p_user_id AND tm.case_id IS NOT DISTINCT FROM p_case_id)
  ) THEN
    RAISE EXCEPTION 'requested order references a row not owned by the caller';
  END IF;

  CREATE TEMP TABLE _trophy_reorder ON COMMIT DROP AS
    SELECT tm.*, o.ord::int AS _new_slot
    FROM trophy_moments tm
    JOIN unnest(p_ordered_ids) WITH ORDINALITY AS o(id, ord) ON o.id = tm.id
    WHERE tm.user_id = p_user_id AND tm.case_id IS NOT DISTINCT FROM p_case_id;

  DELETE FROM trophy_moments
   WHERE user_id = p_user_id AND case_id IS NOT DISTINCT FROM p_case_id;

  INSERT INTO trophy_moments (
    id, user_id, slot, moment_id, edition_id, player_name, set_name, serial_number,
    circulation_count, tier, thumbnail_url, video_url, fmv, badges, pinned_at,
    collection_id, note, case_id
  )
  SELECT
    id, user_id, _new_slot, moment_id, edition_id, player_name, set_name, serial_number,
    circulation_count, tier, thumbnail_url, video_url, fmv, badges, pinned_at,
    collection_id, note, case_id
  FROM _trophy_reorder;
END;
$function$;

-- anon-exec: revoked (reorder_trophy_slots) — new 3-arg signature; revoked FROM PUBLIC, anon, authenticated below, service_role only as before.
revoke execute on function public.reorder_trophy_slots(uuid, bigint[], uuid) from public, anon, authenticated;
grant execute on function public.reorder_trophy_slots(uuid, bigint[], uuid) to service_role;

-- ── 7. get_trophy_slab_data gains p_case_id (DEFAULT NULL = main case) ──────
-- Body otherwise VERBATIM from 20260930060000 (prosrc md5 verified equal to live
-- before this was written). Two edits: `tm.case_id` is projected, and the WHERE
-- scopes to one case. Signature change → DROP + CREATE; ACL restated as it was
-- (service_role only; anon=false, authenticated=false). get_trophy_slab_data_by_username
-- calls it with one argument and so keeps reading the main case unchanged.

drop function public.get_trophy_slab_data(uuid);

CREATE OR REPLACE FUNCTION public.get_trophy_slab_data(p_user_id uuid, p_case_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH slabs AS (
    SELECT
      tm.id, tm.slot, tm.case_id, tm.moment_id, tm.edition_id,
      COALESCE(e.player_name, tm.player_name) AS player_name,
      COALESCE(e.set_name,    tm.set_name)    AS set_name,
      tm.serial_number,
      CASE
        WHEN tm.serial_number IS NOT NULL
         AND e.circulation_count IS NOT NULL
         AND tm.serial_number > e.circulation_count
        THEN CASE
               WHEN tm.circulation_count IS NOT NULL
                AND tm.serial_number <= tm.circulation_count
               THEN tm.circulation_count
               ELSE NULL::int
             END
        ELSE COALESCE(e.circulation_count, tm.circulation_count)
      END AS circulation_count,
      COALESCE(e.tier::text, tm.tier) AS tier,
      -- ⭐ THE ONE DISPLAY FIELD WITH NO LIVE SIDE, until 2026-09-12. Every
      -- neighbour here is COALESCE(e.<live>, tm.<snapshot>); art alone was the
      -- frozen pin-time value, so a trophy whose stored URL was junk had
      -- nothing to fall back to and published as a blank slab. One live row
      -- (1 of 22) carries a truncated static render that 404s, and it belongs
      -- to one of the 4 of 7 collectors who have pinned exactly one Moment.
      --
      -- ⚠ THE SNAPSHOT WINS HERE AND LOSES EVERYWHERE ELSE, deliberately, and
      -- the asymmetry is measured rather than stylistic: 7 of the 8 rows where
      -- the two disagree store assets.nbatopshot.com/media/<nft>/image?width=
      -- 180|512 — a per-serial derivative of ~31KB — against an `editions`
      -- master that is a 2880x2880 PNG of 4-7MB. Live-first would swap eight
      -- working thumbnails for eight masters, several of them over the OG
      -- card's own byte cap. So this is a FALLBACK, not a preference: it fires
      -- only where the stored art is absent, which is exactly what
      -- sanitizeTrophyThumbnail() produces when it rejects a URL.
      COALESCE(tm.thumbnail_url, e.thumbnail_url) AS thumbnail_url,
      COALESCE(e.video_url, tm.video_url) AS video_url,
      COALESCE(f.fmv_usd, tm.fmv) AS fmv,
      f.confidence AS fmv_confidence,
      -- Phase 2 serial-adjusted FMV (additive; owner surface renders it now).
      public.serial_fmv_estimate(
        tm.collection_id,
        tm.serial_number,
        CASE
          WHEN tm.serial_number IS NOT NULL
           AND e.circulation_count IS NOT NULL
           AND tm.serial_number > e.circulation_count
          THEN CASE
                 WHEN tm.circulation_count IS NOT NULL
                  AND tm.serial_number <= tm.circulation_count
                 THEN tm.circulation_count
                 ELSE NULL::int
               END
          ELSE COALESCE(e.circulation_count, tm.circulation_count)
        END,
        COALESCE(e.tier::text, tm.tier),
        COALESCE(f.fmv_usd, tm.fmv),
        f.confidence::text,
        (CASE WHEN e.jersey_number > 1 THEN e.jersey_number END),
        e.id
      ) AS serial_fmv,
      COALESCE(
        CASE WHEN e.id IS NOT NULL THEN (
          SELECT jsonb_agg(elem->>'title')
          FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) elem
          WHERE elem->>'title' IS NOT NULL
        ) END,
        to_jsonb(tm.badges)
      ) AS badges,
      tm.note,
      tm.collection_id,
      c.slug AS collection_slug,
      c.name AS collection_display_name,
      e.play_category AS play_description,
      e.team_name AS team_name,
      e.series AS series,
      -- Special-serial jersey match (lib/badges/glyphs.ts specialCats). NULL
      -- unless > 0: 0 means no number on file, never jersey #0.
      (CASE WHEN e.jersey_number > 0 THEN e.jersey_number END) AS jersey_number,
      tm.pinned_at,
      -- Is the trophy still in the collector's indexed holdings? THREE states
      -- (2026-09-28): 'held' / 'not_held' / 'unknown'. 'not_held' needs a CLEAN
      -- walk after the pin for every relevant wallet or linked username; without
      -- one the answer is 'unknown', never a guess.
      hs.held_state,
      hs.held_checked_at,
      (
        SELECT ma.buy_price FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
          AND ma.collection_id = tm.collection_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquired_price,
      (
        SELECT ma.acquisition_method FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
          AND ma.collection_id = tm.collection_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquisition_method
    FROM trophy_moments tm
    LEFT JOIN LATERAL (
      SELECT w.edition_key
      FROM wallet_moments_cache w
      WHERE w.moment_id = tm.moment_id
        AND w.collection_id = tm.collection_id
        AND w.edition_key IS NOT NULL
      LIMIT 1
    ) wk ON true
    LEFT JOIN editions e
      ON e.external_id    = COALESCE(wk.edition_key, tm.edition_id)
     AND e.collection_id  = tm.collection_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) f ON true
    LEFT JOIN collections c ON c.id = tm.collection_id
    LEFT JOIN LATERAL (
      WITH uw AS (
        SELECT DISTINCT sw.wallet_addr FROM saved_wallets sw WHERE sw.user_id = tm.user_id
      ),
      -- FLOW / SOLANA: the moment under any of the user's saved wallets.
      w_present AS (
        SELECT EXISTS (
          SELECT 1 FROM wallet_moments_cache w
          JOIN uw ON uw.wallet_addr = w.wallet_address
          WHERE w.moment_id = tm.moment_id AND w.collection_id = tm.collection_id
        ) AS present
      ),
      -- The wallets that hold anything in this collection (or were cleanly
      -- walked for it). Each must have a clean walk AFTER the pin, and a recent
      -- one: prune_stale_wmc drops rows unseen for 14 days, and a clean walk
      -- refreshes every held row, so a floor older than 13 days could be
      -- looking at a pruned-but-held moment.
      w_relevant AS (
        SELECT uw.wallet_addr, cw.last_clean_walk_at
        FROM uw
        LEFT JOIN wmc_clean_walks cw
          ON cw.wallet_address = uw.wallet_addr AND cw.collection_id = tm.collection_id
        WHERE cw.wallet_address IS NOT NULL
           OR EXISTS (SELECT 1 FROM wallet_moments_cache w2
                      WHERE w2.wallet_address = uw.wallet_addr AND w2.collection_id = tm.collection_id)
      ),
      -- PANINI: cards under the usernames the user linked.
      p_names AS (
        SELECT sci.identity_value AS username, pw.last_complete_at, pw.profile_state
        FROM saved_collector_identities sci
        LEFT JOIN panini_collector_walks pw ON pw.username = sci.identity_value
        WHERE sci.user_id = tm.user_id AND sci.collection_id = tm.collection_id
          AND sci.identity_kind = 'username'
      ),
      p_present AS (
        SELECT EXISTS (
          SELECT 1 FROM panini_user_holdings h JOIN p_names n ON n.username = h.username
          WHERE h.url_key = tm.moment_id
        ) OR EXISTS (
          SELECT 1 FROM panini_card_serials s JOIN p_names n ON s.owner <> '' AND lower(s.owner) = n.username
          WHERE s.sku = tm.moment_id AND COALESCE(s.serial_state, '') <> 'BURNT'
            AND (n.last_complete_at IS NULL OR s.captured_at > n.last_complete_at)
        ) AS present
      )
      SELECT
        CASE
          WHEN c.slug = 'panini_blockchain' THEN
            CASE
              WHEN (SELECT present FROM p_present) THEN 'held'
              WHEN EXISTS (SELECT 1 FROM p_names)
               AND NOT EXISTS (SELECT 1 FROM p_names n
                               WHERE n.last_complete_at IS NULL OR n.last_complete_at <= tm.pinned_at
                                  OR n.profile_state IS DISTINCT FROM 'public')
              THEN 'not_held'
              ELSE 'unknown'
            END
          ELSE
            CASE
              WHEN (SELECT present FROM w_present) THEN 'held'
              WHEN EXISTS (SELECT 1 FROM w_relevant)
               AND NOT EXISTS (SELECT 1 FROM w_relevant r
                               WHERE r.last_clean_walk_at IS NULL
                                  OR r.last_clean_walk_at <= tm.pinned_at
                                  OR r.last_clean_walk_at < now() - interval '13 days')
              THEN 'not_held'
              ELSE 'unknown'
            END
        END AS held_state,
        CASE
          WHEN c.slug = 'panini_blockchain' THEN (SELECT min(n.last_complete_at) FROM p_names n)
          ELSE (SELECT min(r.last_clean_walk_at) FROM w_relevant r)
        END AS held_checked_at
    ) hs ON true
    WHERE tm.user_id = p_user_id
      -- ⭐ ONE CASE PER READ (2026-11-06, multiple trophy cases). NULL = the
      -- collector's main case; a trophy_cases.id = that named/challenge case.
      -- Without this a challenge entry's slot 1 rendered INSIDE the main case.
      AND tm.case_id IS NOT DISTINCT FROM p_case_id
    ORDER BY tm.slot ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(slabs.*) ORDER BY slot), '[]'::jsonb)
  INTO v_result FROM slabs;

  RETURN v_result;
END;
$function$;
-- anon-exec: revoked (get_trophy_slab_data) — new 2-arg signature; revoked FROM PUBLIC, anon, authenticated below, service_role only as before.
REVOKE EXECUTE ON FUNCTION public.get_trophy_slab_data(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_trophy_slab_data(uuid, uuid) TO service_role;

-- ── 8. Reads for the extra cases ───────────────────────────────────────────

-- Every extra case a user has, newest-challenge-first then by creation, each
-- with its slabs (same enriched shape as the main case). Owner/service read.
create or replace function public.get_trophy_cases_for_user(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(x.obj ORDER BY x.sort_challenge, x.created_at), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      (tc.challenge_id IS NULL) AS sort_challenge,
      tc.created_at,
      jsonb_build_object(
        'id', tc.id,
        'name', tc.name,
        'created_at', tc.created_at,
        'first_pinned_at', tc.first_pinned_at,
        'completed_at', tc.completed_at,
        'challenge', CASE WHEN ch.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', ch.id, 'slug', ch.slug, 'title', ch.title, 'tagline', ch.tagline,
          'description', ch.description, 'rules', ch.rules,
          'starts_at', ch.starts_at, 'ends_at', ch.ends_at, 'is_active', ch.is_active
        ) END,
        'slabs', public.get_trophy_slab_data(tc.user_id, tc.id)
      ) AS obj
    FROM trophy_cases tc
    LEFT JOIN trophy_challenges ch ON ch.id = tc.challenge_id
    WHERE tc.user_id = p_user_id
  ) x;

  RETURN v_result;
END;
$function$;

-- anon-exec: revoked (get_trophy_cases_for_user) — new owner read; revoked FROM PUBLIC, anon, authenticated below. Public reads go through get_trophy_cases_by_username.
revoke execute on function public.get_trophy_cases_for_user(uuid) from public, anon, authenticated;
grant execute on function public.get_trophy_cases_for_user(uuid) to service_role;

-- Public profile read. Mirrors get_trophy_slab_data_by_username: unknown or
-- blank username -> '[]'. Trophy cases are public the same way the main case is
-- (trophy_moments_select_public USING true).
create or replace function public.get_trophy_cases_by_username(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_username IS NULL OR length(trim(p_username)) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT user_id INTO v_user_id
  FROM profile_bio
  WHERE lower(username) = lower(trim(p_username))
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN public.get_trophy_cases_for_user(v_user_id);
END;
$function$;

-- anon-exec: intentional (get_trophy_cases_by_username) — public profile read, same posture as get_trophy_slab_data_by_username (anon=true); returns only what trophy_moments_select_public already exposes.
grant execute on function public.get_trophy_cases_by_username(text) to anon, authenticated, service_role;

-- A challenge and its entries: every case entered in it that holds at least one
-- pin, owner username attached (a case whose owner has no public username is
-- left out — there is no page to link it to). Unknown slug -> NULL.
create or replace function public.get_trophy_challenge_entries(p_slug text, p_limit int default 48)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_ch trophy_challenges%ROWTYPE;
  v_entries jsonb;
  v_total int;
BEGIN
  SELECT * INTO v_ch FROM trophy_challenges WHERE slug = lower(trim(p_slug));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_total
  FROM trophy_cases tc
  JOIN profile_bio pb ON pb.user_id = tc.user_id AND pb.username IS NOT NULL
  WHERE tc.challenge_id = v_ch.id
    AND EXISTS (SELECT 1 FROM trophy_moments tm WHERE tm.case_id = tc.id);

  SELECT COALESCE(jsonb_agg(e.obj ORDER BY e.slab_count DESC, e.last_pin DESC), '[]'::jsonb)
  INTO v_entries
  FROM (
    SELECT
      s.slab_count, s.last_pin,
      jsonb_build_object(
        'case_id', tc.id,
        'username', pb.username,
        'slab_count', s.slab_count,
        'completed_at', tc.completed_at,
        'slabs', public.get_trophy_slab_data(tc.user_id, tc.id)
      ) AS obj
    FROM trophy_cases tc
    JOIN profile_bio pb ON pb.user_id = tc.user_id AND pb.username IS NOT NULL
    JOIN LATERAL (
      SELECT count(*)::int AS slab_count, max(tm.pinned_at) AS last_pin
      FROM trophy_moments tm WHERE tm.case_id = tc.id
    ) s ON s.slab_count > 0
    WHERE tc.challenge_id = v_ch.id
    ORDER BY s.slab_count DESC, s.last_pin DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 48), 100))
  ) e;

  RETURN jsonb_build_object(
    'challenge', jsonb_build_object(
      'id', v_ch.id, 'slug', v_ch.slug, 'title', v_ch.title, 'tagline', v_ch.tagline,
      'description', v_ch.description, 'rules', v_ch.rules,
      'starts_at', v_ch.starts_at, 'ends_at', v_ch.ends_at, 'is_active', v_ch.is_active
    ),
    'entry_count', v_total,
    'entries', v_entries
  );
END;
$function$;

-- anon-exec: intentional (get_trophy_challenge_entries) — the public /trophy-challenges/<slug> board; exposes only usernames + pinned trophies, which are already public on each profile.
grant execute on function public.get_trophy_challenge_entries(text, int) to anon, authenticated, service_role;

-- ── 9. The first challenge ─────────────────────────────────────────────────

insert into public.trophy_challenges (slug, title, tagline, description, rules)
values (
  'dame-time',
  'Dame Time',
  'Show off your favorite Damian Lillard Moments and Panini cards.',
  'Build a case of up to 6 of your favorite Damian Lillard pieces: NBA Top Shot Moments and Panini cards both count. Only Dame pieces you hold can go in.',
  jsonb_build_object(
    'player_names', jsonb_build_array('Damian Lillard'),
    'collection_slugs', jsonb_build_array('nba_top_shot', 'panini_blockchain'),
    'require_owned', true
  )
);
