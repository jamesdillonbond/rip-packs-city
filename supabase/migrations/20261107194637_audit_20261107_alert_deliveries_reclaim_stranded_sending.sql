-- 2026-11-07 (PT) — a delivery stranded in 'sending' was never retried.
--
-- claim_pending_deliveries moves rows pending → 'sending' and only ever claims
-- 'pending'. Nothing reset a 'sending' row, so a tick killed at the route's 60 s
-- maxDuration (observed max 58.7 s), or a mark that did not land, left those
-- deliveries stranded for good: never sent, never re-queued, never failed
-- (fresh-eyes review of the alerts pipeline, 2026-11-07; finding queued in the
-- same day's ledger entry and fixed here). 0 rows were in 'sending' when this
-- was written, so it is a latent fix.
--
-- Why a NEW column, not created_at: a reset keyed on created_at would hand a row
-- that a concurrent tick is sending RIGHT NOW (claimed seconds ago, created long
-- ago) to a second tick — a double send. claimed_at says when THIS claim began.
--
-- The rule, inside the claim (one function, no new schedule):
--   * 'sending' with claimed_at older than 10 minutes (10 × the 60 s wall) is
--     stranded. Under 5 attempts it goes back to 'pending'; at 5 it becomes
--     'failed' with last_error 'stranded in sending' — the same 5-attempt limit
--     mark_delivery_failed applies, so a row that strands every time cannot
--     cycle forever.
--   * a 'sending' row with NULL claimed_at (claimed before this column existed)
--     is treated as stranded too — there were 0 at apply time.
--   * every claim stamps claimed_at.
-- Signature, SECURITY DEFINER, search_path and grants (service_role, postgres)
-- are unchanged; CREATE OR REPLACE keeps the grants.
--
-- Revert:
--   re-create claim_pending_deliveries from the body below WITHOUT the reclaim
--   CTEs and without `claimed_at = now()`, then
--   ALTER TABLE public.alert_deliveries DROP COLUMN claimed_at;

ALTER TABLE public.alert_deliveries ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_pending_deliveries(p_channel text, p_max integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  -- Stranded claims first: back to pending under the attempt limit, failed at it.
  UPDATE public.alert_deliveries
  SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
      last_error = CASE WHEN attempts >= 5 THEN 'stranded in sending' ELSE last_error END
  WHERE channel = p_channel
    AND status = 'sending'
    AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes');

  WITH claimed AS (
    SELECT id FROM public.alert_deliveries
    WHERE channel = p_channel AND status = 'pending'
    ORDER BY created_at
    LIMIT GREATEST(p_max,1)
    FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE public.alert_deliveries d
    SET status = 'sending', attempts = attempts + 1, claimed_at = now()
    FROM claimed WHERE d.id = claimed.id
    RETURNING d.id, d.owner_key, d.channel, d.channel_user_id, d.alert_kind, d.subject_key, d.payload
  )
  SELECT COALESCE(jsonb_agg(row_to_json(upd)::jsonb), '[]'::jsonb) INTO v_rows FROM upd;

  RETURN jsonb_build_object('channel', p_channel, 'count', COALESCE(jsonb_array_length(v_rows),0), 'deliveries', v_rows);
END;
$function$;
