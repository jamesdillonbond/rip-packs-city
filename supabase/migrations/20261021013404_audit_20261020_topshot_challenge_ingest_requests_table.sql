-- audit_20261020_topshot_challenge_ingest_requests_table
-- The request-id table for the Atlas QuestService challenge ingest (begin/collect over pg_net).
-- Applied on its own ahead of 20261021014500_audit_20261020_topshot_challenges_from_atlas_quests,
-- whose functions carry the DELETE text the migration tool refuses; see that file for the lane.
--
-- REVERT: DROP TABLE public.topshot_challenge_ingest_requests;

CREATE TABLE public.topshot_challenge_ingest_requests (
  request_id   bigint PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  collected_at timestamptz
);
ALTER TABLE public.topshot_challenge_ingest_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_challenge_ingest_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_challenge_ingest_requests TO service_role;
COMMENT ON TABLE public.topshot_challenge_ingest_requests IS 'pg_net request ids for the Atlas QuestService challenge ingest (begin/collect). audit_20261020.';
