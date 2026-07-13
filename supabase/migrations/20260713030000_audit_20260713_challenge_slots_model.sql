-- Challenge Builder VARIABLE-challenge slot model. Every live Top Shot challenge is N
-- independent LOCK slots, each a query (player + set + series + optional play-category),
-- satisfied by locking ONE eligible moment. This replaces the "own the whole base set"
-- approximation in challenge_editions (which over-counted required moments ~1.3-2x).
-- See docs/audits/challenge-tracker-review-2026-07-13.md.
-- Revert: DROP TABLE public.challenge_slot_editions, public.challenge_slots CASCADE;

CREATE TABLE IF NOT EXISTS public.challenge_slots (
  challenge_id     uuid NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  slot_order       integer NOT NULL,
  label            text,                 -- player name as Top Shot shows it
  nba_stats_id     text,                 -- slot query byPlayers[0] (NBA stats id)
  set_external_id  text,                 -- slot query bySets[0] (Top Shot set UUID)
  series           text,                 -- slot query bySeries[0] (e.g. '8')
  play_category    text,                 -- slot query byPlayCategory[0] (Dunk/Reel/3 Pointer), nullable
  help_text        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, slot_order)
);

-- Resolved eligibility: the editions that satisfy a slot. One slot -> 1+ eligible editions
-- (a player can have multiple qualifying plays; you lock the cheapest). Repopulated by
-- resolve_challenge_slot_editions().
CREATE TABLE IF NOT EXISTS public.challenge_slot_editions (
  challenge_id     uuid NOT NULL,
  slot_order       integer NOT NULL,
  external_id      varchar(100) NOT NULL,   -- 'setID:playID', same key as editions/mv catalog
  play_id_onchain  integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, slot_order, external_id),
  FOREIGN KEY (challenge_id, slot_order)
    REFERENCES public.challenge_slots(challenge_id, slot_order) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_challenge_slots_challenge ON public.challenge_slots(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_slot_editions_ext ON public.challenge_slot_editions(external_id);
CREATE INDEX IF NOT EXISTS idx_challenge_slot_editions_slot ON public.challenge_slot_editions(challenge_id, slot_order);

ALTER TABLE public.challenge_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_slot_editions ENABLE ROW LEVEL SECURITY;
