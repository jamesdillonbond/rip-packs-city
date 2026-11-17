-- audit_20260829_pool_spells_need_wave_and_long_vacuum_together
-- Cowork cloud pass, 2026-08-29 ~20:25Z (13:25 PT).
-- METADATA ONLY. Adds the FIRST comment on public.wallet_moments_cache.
-- No behaviour, no data, no storage parameter, no grant, no index.
-- REVERT: COMMENT ON TABLE public.wallet_moments_cache IS NULL;
-- Guarded: RAISEs if the table already carries a comment (so a concurrent
-- writer's text can never be clobbered).

DO $mig$
DECLARE
  cur text;
  got int;
BEGIN
  SET LOCAL lock_timeout = '5s';

  SELECT obj_description('public.wallet_moments_cache'::regclass, 'pg_class') INTO cur;
  IF cur IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-STATE MISMATCH: wallet_moments_cache already has a comment (% chars). Refusing to overwrite.', length(cur);
  END IF;

  EXECUTE format('COMMENT ON TABLE public.wallet_moments_cache IS %L', $c$Hot denormalised wallet/moment cache. ~2.5M rows, ~1.99GB of indexes, three FMV writers rewriting its columns around the clock. reloptions carry autovacuum_vacuum_scale_factor=0.02 deliberately.

=== 2026-08-29 ~20:25Z (Cowork cloud pass) — THIS TABLE'S AUTOVACUUM IS ONE OF TWO NECESSARY TERMS IN EVERY CONNECTION-POOL SPELL ON THE INSTANCE, AND ALONE IT IS NOT SUFFICIENT. ===

CONTEXT. The 2026-08-29 ~18:45Z ledger entry ("seven pool-timeout alarms are one autovacuum spell") correctly identified a 3,012s in-flight autovacuum on THIS table as the mechanism behind the 18:00Z pool-exhaustion spell, and correctly recorded that it was ONE OBSERVED CASE, not a rate, because pg_stat_activity is a live view. This note closes that gap and then narrows the claim.

⭐ THE MISSING INSTRUMENT. log_autovacuum_min_duration = 600000 (10 min) on this instance, so EVERY autovacuum lasting >= 600s is written to postgres_logs and IS reconstructable via the Supabase logs API. The windows are NOT unrecoverable. In the 24h to 2026-08-29 20:16Z there were exactly SIX such vacuums and ALL SIX were on this table (no other relation appears): completions 05:46:12, 10:05:41, 13:46:51, 14:01:44, 16:45:11, 18:50:52Z.
⚠ LIMIT OF THE INSTRUMENT: the log pipeline stores only the FIRST LINE of the autovacuum message (len 80, "…: index scans: 1"), so DURATIONS ARE NOT RECOVERABLE — only completion time and a >=600s floor. And "no logged vacuum" means "none >= 600s", never "none".

⭐ THE SECOND TERM, which the ledger entry did not have: the WALLET-BACKFILL WAVE (pipeline LIKE 'wallet-backfill%'). Measured over the same 24h from pipeline_runs, per UTC hour, NON-wave run count is FLAT at 415-526 in all 24 hours — so 100% of the hour-to-hour concurrency variation on this instance is the wave, and nothing else.

⭐ THE 2x2, n=24 hours, ZERO false positives and ZERO false negatives:
  wave ACTIVE + long wmc vacuum -> 09Z 91 pool errors · 13Z 9 · 17Z 2 · 18Z 48   (4 of 4 fire)
  wave ACTIVE, no long vacuum   -> 23Z 0 · 00Z 0 · 01Z 0 · 12Z 0                 (0 of 4)
  wave QUIET + long wmc vacuum  -> 05Z 0 · 10Z 0 · 14Z 0 · 16Z 0                 (0 of 4)
  neither                        -> 12 hours, all 0
NECESSITY IS EXACT: all 150 pool errors in 24h fall in wave-active hours; the 16 wave-quiet hours hold ZERO.

⭐ AND BURST SIZE IS REFUTED AS THE DRIVER — the control that matters. Peak wave runs/minute by hour: 01Z 96 (HIGHEST of the day) -> 0 errors; 23Z 90 -> 0; 00Z 88 -> 0; 09Z 92 -> 91; 12Z 77 -> 0; 13Z 72 -> 9; 17Z 72 -> 2; 18Z 49 (LOWEST of the eight wave hours) -> 48 errors. The hour with the most pool errors had the SMALLEST bursts and the hour with the biggest bursts had none. ⛔ Do NOT attribute the spells to wave volume, and do not "fix" them by throttling the wave alone.

⛔ HOW STRONG EACH CELL ACTUALLY IS — do not quote the 2x2 without this:
 · 18Z is DIRECTLY ESTABLISHED: vacuum start ~17:52Z (read live at 18:42Z at 3,012s age), pool errors 17:58-18:20Z. Errors begin 6 min after the vacuum starts.
 · ⚠ AND THE VACUUM IS NOT SUFFICIENT EVEN WITHIN THAT HOUR: it ran on to 18:50:52Z, a further 30 min AFTER the errors stopped at 18:20Z. The wave burst is what switches the spell on and off inside the hour.
 · 09Z and 13Z are CONSISTENT BUT NOT ESTABLISHED: errors ran 09:24-09:51 and 13:16-13:32, while the >=600s certainty windows only reach back to 09:55 and 13:36. Covering them needs vacuums of ~2,500s and ~1,800s — both under the one directly-measured 3,012s, so plausible, but the durations are unrecoverable (see LIMIT above).
 · The strongest NEGATIVE evidence is 23Z/00Z/01Z: the three biggest wave bursts of the day, inside a 9.5h window (20:00Z 08-28 -> 05:46Z 08-29) containing no logged >=600s vacuum at all, and zero pool errors.

👉 CONSEQUENCES.
 (1) The six wallet-backfill max_silent_minutes arms are NOT merely a noisy threshold to wave past — the wave they describe is one of the two necessary terms in every spell today. Re-read that thread with this note.
 (2) A remedy must break the COINCIDENCE, not either term alone. Neither "throttle the wave" nor "retune this table's autovacuum" is supported by this evidence on its own.
 (3) ⛔ STILL NOT A RECOMMENDATION to change autovacuum_vacuum_scale_factor here — the 2026-08-29 ledger entry's reasoning stands (raising it means fewer but LONGER vacuums; lowering it means more; nobody has measured which is better on the hottest table on the instance).
 (4) The 12 public boards reading over max_ms in the 18:28-18:38Z liveness sweep sit INSIDE the 18Z conjunction. Per the standing rule, do not derive a board cost from inside a spell.

⚠ n = ONE DAY. pipeline_runs retains ~73h so the wave side extends to 3 days, but the logs API caps at 24h, so the vacuum side cannot. FALSIFIER: a pool-error spell in a wave-QUIET hour, or a wave-active hour with a logged >=600s vacuum and zero pool errors, refutes the conjunction.$c$);

  SELECT length(obj_description('public.wallet_moments_cache'::regclass, 'pg_class')) INTO got;
  IF got IS NULL OR got < 3000 THEN
    RAISE EXCEPTION 'POST-STATE MISMATCH: comment length reads %', got;
  END IF;
  RAISE NOTICE 'ok: wallet_moments_cache comment now % chars', got;
END
$mig$;