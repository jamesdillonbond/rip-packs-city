-- audit_20260927_trophy_case_campaign_tracking
--
-- Makes "who started / who finished a trophy case, and which campaign drove it"
-- measurable. Before this, the only record was `trophy_moments` itself, and it
-- cannot answer any of those questions:
--
--   · `pinned_at` is OVERWRITTEN by every re-pin (POST upserts the row), so the
--     date a case was STARTED is lost the first time a slot is swapped.
--   · an unpin DELETEs the row, so a case built and then emptied leaves nothing.
--   · no pin ever wrote a funnel_events row, so a pin could not be joined to the
--     session's utm_* / share_ref attribution.
--
-- Four pieces:
--
--   1. trophy_case_milestones — one row per user, SET-ONCE `started_at` (first
--      pin) and `completed_at` (first time all 6 slots were filled). Written by
--      a trigger on trophy_moments, so EVERY writer is covered (the POST route,
--      reorder_trophy_slots, and an authenticated user writing through RLS).
--      Backfilled rows are labelled `backfill_upper_bound`: min/max of the
--      CURRENT pinned_at values can only be LATER than the true moment (re-pins
--      move pinned_at forward, never back), so they are ceilings, not facts.
--   2. funnel_events.user_id + two event types, `trophy_pinned` and
--      `trophy_removed`. SERVER-ONLY: the anon/authenticated INSERT policy now
--      refuses both types and any non-null user_id, so the public beacon
--      endpoint cannot forge a pin for someone else. The authenticated trophy
--      route writes them with the service role and the client's session
--      attribution.
--   3. internal_accounts — presence = the account is ours (founder, brand, QA),
--      so campaign numbers can exclude it. A table rather than a defaulted
--      boolean on user_profiles: a `false` default would CLAIM every unreviewed
--      account is external. Rows are data, inserted outside this file (the
--      emails that identify them do not belong in a public repo).
--   4. Two service-role-only views for the campaign: per user, and per PT day.
--
-- Revert:
--   drop view if exists public.trophy_case_campaign_daily;
--   drop view if exists public.trophy_case_campaign_users;
--   drop trigger if exists trophy_case_milestones_track on public.trophy_moments;
--   drop function if exists public.trophy_case_milestones_track();
--   drop table if exists public.trophy_case_milestones;
--   drop table if exists public.internal_accounts;
--   alter policy funnel_events_anon_insert on public.funnel_events with check (<the pre-image quoted in section 2>);
--   delete from public.funnel_events where event_type in ('trophy_pinned','trophy_removed');
--   restore funnel_events_event_type_check without the two types; drop index funnel_events_user_id_created_idx;
--   alter table public.funnel_events drop column user_id;

-- ── 1. Milestones ──────────────────────────────────────────────────────────

create table public.trophy_case_milestones (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  started_at          timestamptz not null,
  started_at_source   text not null
    check (started_at_source in ('observed', 'backfill_upper_bound')),
  completed_at        timestamptz,
  completed_at_source text
    check (completed_at_source in ('observed', 'backfill_upper_bound')),
  check ((completed_at is null) = (completed_at_source is null))
);

comment on table public.trophy_case_milestones is
  'Set-once trophy-case milestones per user. started_at = first pin, completed_at = first time 6/6 slots were filled. '
  'Source ''observed'' = stamped by the trophy_moments trigger at the moment it happened; '
  '''backfill_upper_bound'' = reconstructed 2026-09-27 from overwritten pinned_at values, so the true time is at or BEFORE it.';

alter table public.trophy_case_milestones enable row level security;
revoke all on public.trophy_case_milestones from anon, authenticated;

-- SECURITY DEFINER because authenticated users may write trophy_moments
-- directly through RLS (trophy_moments_insert_own / _update_own), and they have
-- no grant on trophy_case_milestones. Without it their pin would FAIL on the
-- milestone insert. search_path is pinned empty; every name is qualified.
create or replace function public.trophy_case_milestones_track()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slots int;
begin
  insert into public.trophy_case_milestones (user_id, started_at, started_at_source)
  values (new.user_id, now(), 'observed')
  on conflict (user_id) do nothing;

  select count(*) into v_slots
  from public.trophy_moments
  where user_id = new.user_id;

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

-- anon-exec: revoked (trophy_case_milestones_track) — new SECDEF trigger fn; revoked FROM PUBLIC, anon, authenticated below in ONE statement.
revoke execute on function public.trophy_case_milestones_track() from public, anon, authenticated;
grant execute on function public.trophy_case_milestones_track() to postgres, service_role;

-- UPDATE OF moment_id: a POST upsert onto an occupied slot rewrites moment_id
-- (fires); a caption PATCH does not (no reason to recount).
create trigger trophy_case_milestones_track
after insert or update of moment_id on public.trophy_moments
for each row execute function public.trophy_case_milestones_track();

-- Backfill. min(current pinned_at) >= true first pin, max(current pinned_at)
-- >= true completion, because every re-pin moves pinned_at LATER. Labelled so.
-- A user who built a case and emptied it before today is unrecoverable and is
-- deliberately absent rather than guessed.
insert into public.trophy_case_milestones
  (user_id, started_at, started_at_source, completed_at, completed_at_source)
select
  tm.user_id,
  min(tm.pinned_at),
  'backfill_upper_bound',
  case when count(*) >= 6 then max(tm.pinned_at) end,
  case when count(*) >= 6 then 'backfill_upper_bound' end
from public.trophy_moments tm
join auth.users u on u.id = tm.user_id
where tm.pinned_at is not null
group by tm.user_id
on conflict (user_id) do nothing;

-- ── 2. funnel_events: user_id + server-only trophy events ──────────────────

alter table public.funnel_events
  add column user_id uuid references auth.users(id) on delete set null;

comment on column public.funnel_events.user_id is
  'Set ONLY by authenticated server routes (trophy_pinned / trophy_removed). The anon/authenticated INSERT policy requires it NULL, so a beacon cannot attribute an event to someone else.';

alter table public.funnel_events drop constraint funnel_events_event_type_check;
alter table public.funnel_events add constraint funnel_events_event_type_check
  check (event_type = any (array[
    'home_view', 'wallet_paste', 'share_view', 'share_cta_click',
    'insights_view', 'insights_card_click', 'collection_view',
    'signin_click', 'account_created', 'email_capture_submitted',
    'profile_view',
    'trophy_pinned', 'trophy_removed'
  ]::text[])) not valid;
alter table public.funnel_events validate constraint funnel_events_event_type_check;

-- Pre-image of this policy's WITH CHECK (for the revert):
--   (length(event_type) <= 64) AND ((wallet_address IS NULL) OR (length(wallet_address) <= 80))
--   AND ((session_id IS NULL) OR (length(session_id) <= 128)) AND ((surface IS NULL) OR (length(surface) <= 64))
--   AND ((referrer IS NULL) OR (length(referrer) <= 512))
alter policy funnel_events_anon_insert on public.funnel_events
  with check (
    (length(event_type) <= 64)
    and ((wallet_address is null) or (length(wallet_address) <= 80))
    and ((session_id is null) or (length(session_id) <= 128))
    and ((surface is null) or (length(surface) <= 64))
    and ((referrer is null) or (length(referrer) <= 512))
    and user_id is null
    and event_type <> all (array['trophy_pinned', 'trophy_removed']::text[])
  );

create index funnel_events_user_id_created_idx
  on public.funnel_events (user_id, created_at)
  where user_id is not null;

-- ── 3. Internal accounts ───────────────────────────────────────────────────

create table public.internal_accounts (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  reason    text not null check (length(reason) between 1 and 200),
  marked_at timestamptz not null default now()
);

comment on table public.internal_accounts is
  'Accounts that are ours (founder, brand, QA). PRESENCE = internal; absence means not reviewed as internal, not verified external. Exclude these from campaign and traction numbers.';

alter table public.internal_accounts enable row level security;
revoke all on public.internal_accounts from anon, authenticated;

-- ── 4. Campaign views (service role only) ──────────────────────────────────

create view public.trophy_case_campaign_users
with (security_invoker = on) as
select
  m.user_id,
  (ia.user_id is not null)                          as is_internal,
  ia.reason                                         as internal_reason,
  m.started_at,
  m.started_at_source,
  m.completed_at,
  m.completed_at_source,
  coalesce(s.current_slots, 0)                      as current_slots,
  fp.created_at                                     as first_pin_event_at,
  substring(fp.referrer from 'utm_source=([^&]+)')   as first_pin_utm_source,
  substring(fp.referrer from 'utm_medium=([^&]+)')   as first_pin_utm_medium,
  substring(fp.referrer from 'utm_campaign=([^&]+)') as first_pin_utm_campaign,
  substring(fp.referrer from 'share_ref=([^&]+)')    as first_pin_share_ref
from public.trophy_case_milestones m
left join public.internal_accounts ia on ia.user_id = m.user_id
left join lateral (
  select count(*)::int as current_slots
  from public.trophy_moments tm
  where tm.user_id = m.user_id
) s on true
left join lateral (
  select fe.created_at, fe.referrer
  from public.funnel_events fe
  where fe.user_id = m.user_id
    and fe.event_type = 'trophy_pinned'
  order by fe.created_at
  limit 1
) fp on true;

comment on view public.trophy_case_campaign_users is
  'One row per user who has ever pinned a trophy (since tracking, plus the labelled backfill). first_pin_* is NULL for pins made before 2026-09-27: no event existed then, so it is unknown, not unattributed.';

create view public.trophy_case_campaign_daily
with (security_invoker = on) as
with ev as (
  select (started_at at time zone 'America/Los_Angeles')::date as day_pt,
         'started'::text as milestone, started_at_source as source, is_internal
  from public.trophy_case_campaign_users
  union all
  select (completed_at at time zone 'America/Los_Angeles')::date,
         'completed', completed_at_source, is_internal
  from public.trophy_case_campaign_users
  where completed_at is not null
)
select
  day_pt,
  count(*) filter (where milestone = 'started'   and not is_internal) as started_external,
  count(*) filter (where milestone = 'completed' and not is_internal) as completed_external,
  count(*) filter (where milestone = 'started'   and is_internal)     as started_internal,
  count(*) filter (where milestone = 'completed' and is_internal)     as completed_internal,
  bool_or(source = 'backfill_upper_bound')                            as includes_backfill
from ev
group by day_pt;

comment on view public.trophy_case_campaign_daily is
  'Trophy-case starts/completions per Pacific day, internal accounts split out. includes_backfill = the day holds a reconstructed upper-bound date, not an observed one.';

revoke all on public.trophy_case_campaign_users from anon, authenticated;
revoke all on public.trophy_case_campaign_daily from anon, authenticated;
