-- scripts/challenge-nudge-targets.sql — WHO a mid-challenge reminder would go to (2026-11-09, Cowork
-- cloud, from the Dame Time weekend review). READ-ONLY. It sends nothing: whether and when to email is
-- Trevor's call (11-08 rule: reminders go only after missing-piece data is clean, with RPC branding).
--
-- Why it exists. Dame Time (11-06 → 11-09): two signed-up holders never opened the picker (crottykid 63
-- Dame Moments, alexthedon 43) and five entrants stopped short (blaise_27 2/6 holding 10 eligible
-- editions, rrx69 5/6 holding 15). Nothing reached any of them while the challenge was open.
--
-- RUN: set the slug in `params`, run with MCP execute_sql / psql. One row per registered user who has
-- not completed and EITHER holds at least one eligible piece OR has a partial entry (a partial entrant
-- with nothing provably held still appears, with held = 0 — the first draft dropped samwise222 that way).
-- MEASURED 2026-11-09 against 'dame-time' (after it closed): 17 rows — SIX registered holders could have
-- completed and never started (crottykid 63 held, coach_p0625 23, alexthedon 22, banana_boat 17, awesemo
-- 12, reddiemiller31 7); the review had found two. A null username is an account with no profile handle. samwise222 reads held 0 / pinned 4 / short_by 2:
-- his four are pinned but his wallet's last walk is too old to re-prove them.
--
-- DEFINITIONS (change them here, never in a one-off query):
--   eligible piece = a wallet_moments_cache row under the user's saved wallets whose player_name is in
--                    rules.player_names and whose collection is a ruled Flow collection. Panini cards are
--                    NOT counted (verified per card against a linked username — see the fill route).
--   provably held  = seen within a day of that wallet's newest row, OR locked with a lock check < 14 d —
--                    the same test as fill_partial_challenge_cases and /api/profile/trophy-cases/fill.
--   status         = not_started (no case) · partial (a case below 6).
--   can_finish     = held + pinned ≥ 6 counting distinct moments (the "fill my case" button finishes it).
--   internal       = internal_accounts are excluded (traction rule).
with params as (select 'dame-time'::text as slug),
ch as (
  select c.* from trophy_challenges c join params p on p.slug = c.slug
),
cols as (
  select co.id from collections co, ch
  where co.slug in (select jsonb_array_elements_text(ch.rules->'collection_slugs'))
    and co.id <> 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'  -- Panini: one card at a time, not counted
),
wallets as (
  select distinct sw.user_id, sw.wallet_addr from saved_wallets sw where sw.wallet_addr is not null
),
-- Eligible rows FIRST, freshness only for the wallets that have one: computing every saved wallet's
-- newest row up front timed out (57014) on the first run.
elig as (
  select w.user_id, m.wallet_address, m.moment_id, m.last_seen_at, m.is_locked, m.lock_checked_at
  from wallets w
  join wallet_moments_cache m on m.wallet_address = w.wallet_addr, ch
  where m.player_name in (select jsonb_array_elements_text(ch.rules->'player_names'))
    and m.collection_id in (select id from cols)
),
newest as (
  select e.wallet_address, (select max(x.last_seen_at) from wallet_moments_cache x where x.wallet_address = e.wallet_address) mx
  from (select distinct wallet_address from elig) e
),
held as (
  select e.user_id, count(distinct e.moment_id) held
  from elig e join newest n on n.wallet_address = e.wallet_address
  where e.last_seen_at >= n.mx - interval '1 day' or (e.is_locked and e.lock_checked_at >= now() - interval '14 days')
  group by e.user_id
),
entry as (
  select tc.user_id, tc.completed_at, (select count(*) from trophy_moments t where t.case_id = tc.id) pinned
  from trophy_cases tc join ch on ch.id = tc.challenge_id
),
people as (
  select user_id from held
  union
  select user_id from entry where completed_at is null and pinned < 6
)
select up.username,
       case when e.user_id is null then 'not_started' else 'partial' end as status,
       coalesce(e.pinned, 0) as pinned,
       coalesce(h.held, 0) as held,
       -- a PINNED piece counts toward 6 even when its walk is too old to re-prove it held now
       (greatest(coalesce(h.held, 0), coalesce(e.pinned, 0)) >= 6) as can_finish,
       greatest(0, 6 - greatest(coalesce(h.held, 0), coalesce(e.pinned, 0))) as short_by,
       (select ends_at at time zone 'America/Los_Angeles' from ch) as closes_pt
from people pp
left join held h on h.user_id = pp.user_id
left join entry e on e.user_id = pp.user_id
left join user_profiles up on up.id = pp.user_id
where (e.user_id is null or (e.completed_at is null and e.pinned < 6))
  and not exists (select 1 from internal_accounts ia where ia.user_id = pp.user_id)
order by can_finish desc, held desc;
