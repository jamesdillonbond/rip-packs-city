-- Top Shot Set/Crafting Challenge tracker — storage layer.
-- Source-agnostic: challenges are seeded by the operator (POST /api/admin/challenges/upsert)
-- or a future TS-GraphQL ingest cron via upsert_challenge(); the intelligence RPCs
-- (20260712202000) reuse the set-completion join path (editions/wmc/badge_editions.low_ask)
-- plus pack_ev_latest / fmv for reward valuation and the "is this challenge worth it?" netEv.
-- Revert: DROP TABLE public.challenge_editions, public.challenges CASCADE;

CREATE TABLE IF NOT EXISTS public.challenges (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id             uuid NOT NULL DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,
  slug                      text NOT NULL,
  name                      text NOT NULL,
  challenge_type            text NOT NULL DEFAULT 'set_locking'
                              CHECK (challenge_type IN ('set_locking','crafting','collecting')),
  description               text,
  reward_kind               text CHECK (reward_kind IN ('pack','moment','other')),
  reward_pack_dist_id       text,              -- FK-by-value into pack_ev_latest/pack_distributions.dist_id (text)
  reward_moment_external_id text,              -- FK-by-value into editions.external_id
  reward_label              text,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  total_reward_allocation   integer,
  completed_count           integer,
  status                    text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','ended','upcoming')),
  source                    text NOT NULL DEFAULT 'operator'
                              CHECK (source IN ('operator','topshot_gql')),
  external_id               text,              -- Top Shot's challenge id, when ingested
  image_url                 text,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, slug)
);

CREATE TABLE IF NOT EXISTS public.challenge_editions (
  challenge_id     uuid NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  external_id      varchar(100) NOT NULL,      -- 'setID:playID' — same key as editions/mv catalog
  play_id_onchain  integer,
  required         boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_challenges_status_ends ON public.challenges(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_challenge_editions_ext ON public.challenge_editions(external_id);

-- RLS on (invariant: 0 tables with rowsecurity=false). No policies: all access is via
-- service_role (route handlers) or the SECDEF RPCs in 20260712202000.
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_editions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.trg_challenges_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS challenges_touch_updated_at ON public.challenges;
CREATE TRIGGER challenges_touch_updated_at BEFORE UPDATE ON public.challenges
  FOR EACH ROW EXECUTE FUNCTION public.trg_challenges_touch_updated_at();
