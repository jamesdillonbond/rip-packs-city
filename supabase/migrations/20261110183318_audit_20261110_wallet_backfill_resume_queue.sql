-- audit_20261110_wallet_backfill_resume_queue
--
-- #245: a wallet-backfill walk continues itself by POSTing to its own route, and Vercel refused
-- the depth-3 self-dispatch of a function-started walk with HTTP 508 (INFINITE_LOOP_DETECTED) at
-- 6:54 AM PT 11-10 — the walk stopped. The route now queues a continuation it could not dispatch
-- here, and /api/cron/wallet-backfill-resume (Vercel Cron, every 10 min — a request from OUTSIDE
-- the function chain) dispatches it at the same depth (lib/chains/flow/wallet-backfill-resume.ts).
--
-- One row per wallet (a newer refusal replaces an older one). Service-role only: RLS on, no
-- policies, and no grants to anon / authenticated (the routes use the service role).
--
-- Also watchlisted: `wallet-backfill-resume` runs every 10 min (vercel.json), so 60 min silent /
-- 240 min without an ok run pages (a requeued wallet keeps a run not-ok until it dispatches).
--
-- REVERT: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'wallet-backfill-resume';
--         DROP TABLE public.wallet_backfill_resume_queue; (after reverting the routes).

CREATE TABLE IF NOT EXISTS public.wallet_backfill_resume_queue (
  wallet          text PRIMARY KEY,
  depth           integer NOT NULL CHECK (depth > 0),
  queued_at       timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_wallet_backfill_resume_queue_queued_at
  ON public.wallet_backfill_resume_queue (queued_at);

ALTER TABLE public.wallet_backfill_resume_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wallet_backfill_resume_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wallet_backfill_resume_queue TO service_role;

COMMENT ON TABLE public.wallet_backfill_resume_queue IS
  '#245: wallet-backfill continuations the route could not dispatch (Vercel 508 on a deep self-dispatch chain); drained by /api/cron/wallet-backfill-resume. Service role only.';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES ('wallet-backfill-resume', 60, 240, 'medium',
        '#245 (2026-11-10): Vercel Cron every 10 min (3-59/10) drains wallet_backfill_resume_queue — wallet-backfill continuations refused with HTTP 508. ok=false while a wallet is requeued/dropped.')
ON CONFLICT (pipeline) DO NOTHING;
