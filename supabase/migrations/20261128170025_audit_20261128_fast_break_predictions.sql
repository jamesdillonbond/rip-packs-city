-- audit_20261128_fast_break_predictions
--
-- Fast Break track record (2026-11-28). Before each night's first tipoff, /api/cron/fast-break-predictions
-- stores the model's best lineup from the WHOLE slate (no ownership limit) and the chance it gave of
-- clearing every target; after the box scores land it scores that lineup against what happened.
-- Prediction is written prospectively because the projection blend folds each finished game into the
-- player's season-to-date line — a retroactive "prediction" would already know the answer.
--
-- Three states, never two: cleared NULL = not scored yet (a game not final, or its box score not in);
-- true / false only once every game a pick played in is final AND has box-score rows.
-- Revert: drop table public.fast_break_predictions;
set local lock_timeout = '3s';

create table if not exists public.fast_break_predictions (
  run_id          uuid        not null references public.fast_break_runs(id) on delete cascade,
  game_date       date        not null,
  kind            text        not null default 'slate_best' check (kind in ('slate_best')),
  objective       text,
  targets         jsonb       not null,
  players         jsonb       not null,   -- [{id, name, team, gameId, captain, bench}]
  predicted_p     numeric     not null check (predicted_p >= 0 and predicted_p <= 1),
  per_target      jsonb       not null,   -- [{stat, target, projected, probability}]
  first_tipoff_at timestamptz,
  predicted_at    timestamptz not null default now(),
  actual          jsonb,                  -- {totals:{stat:n}, used:[ids], benchUsed:bool}
  cleared         boolean,
  scored_at       timestamptz,
  primary key (run_id, game_date, kind)
);

alter table public.fast_break_predictions enable row level security;
revoke all on public.fast_break_predictions from anon, authenticated;
grant select, insert, update on public.fast_break_predictions to service_role;

comment on table public.fast_break_predictions is
  'Fast Break track record: the whole-slate best lineup and its predicted chance, written before first tipoff by /api/cron/fast-break-predictions, scored from nba_player_game_stats once every game is final. cleared NULL = not scored yet.';
