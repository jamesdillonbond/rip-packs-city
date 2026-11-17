-- audit_20260831_pause_wallet_username_resolver_cadence_arm
--
-- WHY: on 2026-08-30 18:17Z the wallet-username-resolver was pulled into the dead-host
-- class (public-api.nbatopshot.com has answered 530/1033 since 08-28 ~17Z): its
-- cron-job.org entry was disabled and a bounded pipeline_alert_suppression row
-- (expires 2026-09-13) was added. The suppression row silences get_pipeline_alerts()
-- ONLY. detect_stalled_pipelines() reads pipeline_cadence_watchlist.is_active and does
-- NOT consult pipeline_alert_suppression (ledger 2026-07-11, ufc-listings-indexer), so
-- the deliberately-paused pipeline now files a cadence "stall" that grows forever and
-- can never clear. Measured 2026-08-31 03:0xZ: last run 2026-08-30 18:08:05Z,
-- silent 535 min vs threshold 450, and Vercel runtime logs show ZERO invocations of
-- /api/cron/resolve-wallet-usernames in the 4h window covering the 00:08Z tick.
--
-- Precedent for BOTH the fix and the note convention:
--   * ledger 2026-07-11 (ufc-listings-indexer): suppression does not cover the cadence arm.
--   * ledger 2026-08-16 (topshot-flowty pair): is_active=false + a bracketed note prefix
--     stating the evidence AND the re-activation condition.
-- Same treatment already applied 2026-08-30 03:43Z to compute-topshot-pack-ev,
-- topshot-fmv-populate and topshot-moments-hydrator. This arm and `ingest` were the two
-- later pauses that did not get it; `ingest` is DELIBERATELY LEFT ACTIVE here because it
-- is still firing (5 runs/24h, last 00:53Z) — only its alert is suppressed, not its schedule.
--
-- REVERT: UPDATE public.pipeline_cadence_watchlist
--         SET is_active = true,
--             notes = substring(notes from position('Wallet username resolver.' in notes))
--         WHERE pipeline = 'wallet-username-resolver';
DO $mig$
DECLARE
  v_notes text;
  v_active boolean;
  v_sup int;
  v_new text;
BEGIN
  SELECT notes, is_active INTO v_notes, v_active
    FROM public.pipeline_cadence_watchlist
   WHERE pipeline = 'wallet-username-resolver';

  IF v_notes IS NULL THEN
    RAISE EXCEPTION 'no wallet-username-resolver row in pipeline_cadence_watchlist';
  END IF;

  -- anchor assert: the arm must still be the 08-22 re-pointed row, not something reworked since
  IF v_notes NOT LIKE 'Wallet username resolver. %CADENCE CHANGED 2026-08-18%' THEN
    RAISE EXCEPTION 'watchlist note anchor not matched — arm was rewritten; re-derive before pausing';
  END IF;

  IF v_notes ILIKE '%KEEP THIS ROW ACTIVE%' THEN
    RAISE EXCEPTION 'note carries a KEEP THIS ROW ACTIVE directive — refusing to deactivate';
  END IF;

  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'arm is already inactive — nothing to do';
  END IF;

  IF v_notes LIKE '[PAUSED%' THEN
    RAISE EXCEPTION 'note already carries a PAUSED prefix';
  END IF;

  -- the pause is only legitimate while the dead-host suppression row is in force
  SELECT count(*) INTO v_sup
    FROM public.pipeline_alert_suppression
   WHERE pipeline = 'wallet-username-resolver'
     AND reason LIKE 'dead host 2026-08-30%'
     AND expires_at > now();
  IF v_sup <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 live dead-host suppression row, found %', v_sup;
  END IF;

  v_new :=
'[PAUSED 2026-08-31 — DEAD HOST, arm deactivated, NOT retired. Re-activate with the host.]

EVIDENCE: the resolver''s only upstream is public-api.nbatopshot.com (app/api/cron/resolve-wallet-usernames/route.ts, TS_GQL), which has answered Cloudflare 530/1033 since 2026-08-28 ~17Z (re-probed 2026-08-31 03:0xZ: 530 twice). Its last tick, 2026-08-30 18:08:05Z, logged "all 300 username lookups failed; first: http 530" — resolved 0 of 300 — and at 18:17Z the cron-job.org entry was disabled and a bounded pipeline_alert_suppression row added (expires 2026-09-13). Vercel runtime logs show ZERO invocations of the route in the 4h covering the 00:08Z tick, so the silence is the deliberate pause, not a regression.

WHY THE ARM HAD TO MOVE TOO: pipeline_alert_suppression silences get_pipeline_alerts() ONLY. detect_stalled_pipelines() reads is_active and never consults that table (ledger 2026-07-11, ufc-listings-indexer). Left active, this row files a stall that grows forever and cannot clear — the permanently-red-instrument failure this table already records.

⚠ ASYMMETRY, READ THIS: the suppression row EXPIRES 2026-09-13; this deactivation does NOT expire. If the host is still dead on 2026-09-13 the failure-rate alert returns while the cadence arm stays silent.

RE-ACTIVATE (all three together, do not do one): when the dead-host EXIT is met — POST {__typename} to https://public-api.nbatopshot.com/graphql returns non-5xx TWICE — (1) re-enable the cron-job.org entry for resolve-wallet-usernames, (2) DELETE the pipeline_alert_suppression row, (3) UPDATE public.pipeline_cadence_watchlist SET is_active = true WHERE pipeline = ''wallet-username-resolver''. This pipeline belongs on the known-issues #11 dead-host re-enable checklist, which did not list it.

--- note as of 2026-08-22, unchanged below this line ---

' || v_notes;

  UPDATE public.pipeline_cadence_watchlist
     SET is_active = false,
         notes = v_new
   WHERE pipeline = 'wallet-username-resolver';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update matched no row';
  END IF;
END
$mig$;