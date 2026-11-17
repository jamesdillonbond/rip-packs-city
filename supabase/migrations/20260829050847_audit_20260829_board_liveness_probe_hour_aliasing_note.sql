COMMENT ON FUNCTION public.public_board_liveness_probe(integer) IS
'READS the last public_board_liveness_sweep() result out of public_board_liveness_state and returns the same jsonb shape (so rpc_trust_health_precompute_refresh Leg 8 is unchanged and now costs ~0ms instead of ~86s). Reports budget_exhausted=true -- which Leg 8 maps to 999 -- when the newest sweep is older than 8h or covered fewer boards than are active. p_budget_ms is vestigial, kept so the signature and grants do not change.

=== READ THIS BEFORE ESCALATING OR DE-ESCALATING ON A SINGLE PROBE READ (added 2026-08-29 05:15Z, Cowork) ===

THIS ARM IS ALIASED TO THE HOUR YOU READ IT. budget_exhausted, and therefore the 999 on BOTH public-board trust arms (public_board_empty_count, public_board_slow_count), is a property of WHICH SWEEP RAN LAST, not of board health. Two passes have already reached opposite conclusions from the same system: 2026-08-24 de-escalated the board-watchdog durability fix on a 45/45 read, and 2026-08-28 23:00Z re-escalated it on a probed-8/45 read. Both were sampling artifacts. STATE THE UTC HOUR WITH ANY READING OF THIS PROBE.

MEASURED over all 73 scheduled jobid 288 slots 2026-08-11 -> 2026-08-29 (cron.job_run_details joined to public_board_liveness_history; NOT from any handoff):

  UTC hour | slots | dispatched | succeeded | full 45/45 | truncated
      00   |  19   |    19      |    19     |     19     |     0
      06   |  18   |    17      |    14     |     13     |     1
      12   |  18   |    15      |    10     |      5     |     4
      18   |  18   |    16      |    12     |      5     |     7
     ALL   |  73   |    67      |    55     |     42     |    12

Only 42 of 73 scheduled sweeps (57.5%) delivered a complete 45-board picture. THREE stacked failure modes, all hour-correlated: (1) 6 slots never dispatched at all -- no job_run_details row, the max_worker_processes starvation class, 0 at 00Z and 3 at 12Z; (2) 12 dispatched runs killed at the 900s statement_timeout; (3) 12 successful runs truncated under the 600000ms internal budget (jobid 288 command is SET statement_timeout=''900s''; SELECT public_board_liveness_sweep(600000)).

POSITIVE CONTROL, which is what makes this contention and not a code defect: the 00Z slot is 19 dispatched / 19 succeeded / 19 complete -- a perfect record on the identical workload, identical code and identical budget. Only the hour differs. jobid 288 p50 duration by hour: 73.5s (00Z, n=19) / 299.0s (06Z, n=14) / 503.3s (12Z, n=10) / 611.0s (18Z, n=12). The 18Z p50 is ABOVE the 600s budget, which is why 18Z truncates most.

THE ARM UNDER-REPORTS, IT DOES NOT OVER-REPORT. The obvious reframe -- "read each board''s own checked_at against the 480-min window instead of the newest sweep''s coverage" -- was measured and REFUTED as a way to quieten this: across 2,014 per-board gaps over 18 days, p50 360 min but p95 AND max both 1,440 min, and 690 of 2,014 (34.3%) exceed 480 min. Because a missing or truncated sweep moves all 45 boards together, per-board age would breach MORE often than budget_exhausted does, not less. public_board_empty_count is the platform''s ONLY detector for a dark public /insights board (see its own catches text: candy_holder_board rendered "Holders 0" for DAYS with zero Sentry) -- so for roughly a third of every day that detector is both blind and loud, which is the combination that teaches an operator to skim past the board.

LEVERS: raising max_ms and raising the 480-min freshness window are forbidden doctrine; a 5th slot was measured and refused 2026-08-27 (it would put ~11 min of query time into the worst hour of an IO-bound instance); slicing the schedule is Trevor''s call (R46). NOT YET DECIDED AND NOT SHIPPED: MOVING the four existing slots off 12Z/18Z. That is cadence-neutral, adds zero IO, and is none of the above -- but jobid 288 outcome data exists ONLY for hours 0/6/12/18, so any new offset is a proxy bet, and a proxy-ranked reschedule is exactly what was refuted on jobid 211 on 2026-08-28. Trevor''s call, with the table above as the evidence.

REVERT: restore this comment to the single paragraph above the === line (verbatim in migration 20260829051500 and in the Project doc for the 2026-08-28 night pass).';