-- audit_20260829_pack_reality_top_ev_is_draining_and_both_arms_read_greener
-- Cowork cloud pass, 2026-08-29 ~20:30Z (13:30 PT).
-- METADATA ONLY. Adds the FIRST comment on the view public.topshot_pack_reality_top_ev.
-- No behaviour, no data, no grant, no view body change, no security_invoker change.
-- REVERT: COMMENT ON VIEW public.topshot_pack_reality_top_ev IS NULL;
-- Guarded: RAISEs if the view already carries a comment.

DO $mig$
DECLARE
  cur text;
  got int;
BEGIN
  SET LOCAL lock_timeout = '5s';

  SELECT obj_description('public.topshot_pack_reality_top_ev'::regclass, 'pg_class') INTO cur;
  IF cur IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-STATE MISMATCH: view already has a comment (% chars). Refusing to overwrite.', length(cur);
  END IF;

  EXECUTE format('COMMENT ON VIEW public.topshot_pack_reality_top_ev IS %L', $c$Thin VIEW over public.mv_topshot_pack_reality_top_ev (security_invoker). Powers the "top EV" block of the PUBLIC /insights/pack-reality board, read by app/api/public/insights/pack-reality/route.ts.

=== 2026-08-29 ~20:30Z (Cowork cloud pass) — THIS BOARD IS DRAINING TOWARD EMPTY AND BOTH ARMS THAT SHOULD CATCH IT GET *GREENER* AS IT DOES. ===

⭐ THERE IS NO ROW-WRITER TO CHASE. The 17:19Z handoff asked the next pass to "identify that writer before treating this as either a real staleness or an upstream-outage artifact." There is none: this is a VIEW over an MV. Rows appear and disappear only when jobid 241 rpc-refresh-pack-reality-top-ev re-runs the MV body. ⛔ Do not go looking for an INSERT — no function in schema public inserts here (checked pg_get_functiondef across public, zero matches).

MEASURED ROW COUNT DECAY, all reads live:
  2026-08-02 (materialize migration) : 5 rows
  2026-08-29 18:28:01Z (liveness sweep): 3 rows
  2026-08-29 ~20:25Z (direct)          : 2 rows
snapshotted_at on the surviving two: 2026-08-28 10:07:13Z and 2026-08-28 16:25:16Z. The NEWEST row is ~28 h old and NOTHING NEW HAS ARRIVED — the source stopped producing snapshots, while jobid 241 itself is healthy (15 consecutive REFRESH successes on 34 */2 * * *, 1.7-108.9 s; it refreshed at 18:34:52Z). ⇒ A healthy refresh over a dead source. The refresh job's green status is NOT evidence of freshness.

🚨 BOTH WATCHING ARMS FAIL IN THE SAME DIRECTION, AND THIS IS THE POINT:
 (1) pack_ev_board_max_stale_days is live (not precomputed) and reads max(now() - snapshotted_at). It BREACHED at 2.0017/2 at 17:15Z with three rows. It reads ~1.43 now and is GREEN — not because anything got fresher, but because the OLDEST row was dropped by a refresh. ⛔ DELETING STALE DATA LOWERS THIS METRIC. It cannot tell "fresh data arrived" from "stale data was pruned", and it will re-breach in roughly 20 h when the 16:25Z row crosses 2 days.
 (2) public_board_empty_count carries this view at min_rows = 1, so a board that has gone 5 -> 3 -> 2 stays clean until it reaches ZERO. min_rows is documented as "25% of each board's measured population"; against the 5 rows of 2026-08-02 that would be 1 by rounding, so the collapse-detector has no room to fire before the board is completely dark.
⇒ ⭐ A BOARD DRAINING TO EMPTY MAKES BOTH ARMS GREENER RATHER THAN REDDER. This is the same shape as the candy_holder_board incident the empty_count arm was built for ("Holders 0" on a live public board for DAYS with zero alerts) — the arm exists, and this population is under its floor.

👉 WHAT A NEXT PASS SHOULD DO (none of it done here, and none of it is Cowork-safe unilaterally):
 · Trace WHY the MV body now yields 2 rows — it is a DISTINCT ON over pack_ev_history joined to pack_ask_state; the plausible link is the dead public-api.nbatopshot.com legacy endpoint the 16:30Z ledger correction files (Cloudflare 530/1033), but that is NOT established here.
 · min_rows on this row is Trevor's call, not a Cowork edit: raising it to 3 or 4 would fire TODAY, which is the point, but changing a liveness floor is a watchlist policy change.
 · pack_ev_board_max_stale_days would be honest if it read MIN age (newest row) rather than MAX age — max() is the wrong aggregate for "has anything new arrived". Also a policy change, also Trevor's.
⚠ Only the row counts and timestamps above are measured. The cause is not.$c$);

  SELECT length(obj_description('public.topshot_pack_reality_top_ev'::regclass, 'pg_class')) INTO got;
  IF got IS NULL OR got < 2000 THEN
    RAISE EXCEPTION 'POST-STATE MISMATCH: comment length reads %', got;
  END IF;
  RAISE NOTICE 'ok: view comment now % chars', got;
END
$mig$;