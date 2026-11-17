-- audit_20260830_dead_host_class_wallet_username_resolver_paused_and_suppressed
--
-- WHY: the 18:08Z wallet-username-resolver tick proved the 20260830155848 candidate fix works (300
-- wallets in 5 s instead of a 60 s statement timeout) and then failed anyway: "all 300 username
-- lookups failed; first: http 530" -- the resolver's username source is the dead
-- public-api.nbatopshot.com GraphQL. Ninth member of the 2026-08-28 dead-host class.
--
-- WHAT: the cron-job.org entry "RPC Resolve Wallet Usernames" (id 7776245, every 3 h at :08) was
-- DISABLED in the console at 18:2xZ (Common tab -> Enable job off; list shows Inactive) -- one click
-- to re-enable. This migration adds the matching bounded alert suppression row (same shape and
-- expiry as 20260830034312 / 20260830155543) so get_pipeline_alerts() does not carry a stale 2-day
-- failure window for a pipeline that is deliberately paused.
--
-- EXIT (same as the class): the host answers non-5xx twice -> re-enable the console entry, DELETE
-- this row. Expires on its own 2026-09-13 either way.
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'wallet-username-resolver';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_alert_suppression WHERE pipeline = 'wallet-username-resolver') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: wallet-username-resolver suppression already exists';
  END IF;
  INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
  VALUES ('wallet-username-resolver',
          'dead host 2026-08-30: public-api.nbatopshot.com 530/1033 since 08-28; cron-job.org entry 7776245 disabled 18:2xZ; re-enable + delete this row when the host answers non-5xx twice',
          '2026-09-13T00:00:00Z');
  IF (SELECT count(*) FROM public.pipeline_alert_suppression WHERE expires_at > now()) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: live suppression count out of sane range';
  END IF;
END $$;
