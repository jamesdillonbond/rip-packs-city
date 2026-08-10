# Operator handoff — rotate the 8 pack-pipeline edge gate keys (deep-audit D2)

**Status: code is de-hardcoded and pushed. The LIVE keys are still burned and the deployed functions still hold them. Rotation needs Trevor — it cannot be done from a Claude Code session.**

## What was wrong

Eight pack ingest/backfill/compute edge functions each carried `const GATE = "rpc_pls_…"` — a plaintext key in a **public** repo, acting as the **sole** auth on a `service_role` writer:

| edge function | new secret name | pg_cron callers |
|---|---|---|
| `ingest-allday-pack-opens` | `ALLDAY_PACK_OPENS_GATE_KEY` | 20, 55 |
| `ingest-topshot-pack-opens-history` | `TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY` | 56 |
| `ingest-pinnacle-mints` | `PINNACLE_MINTS_GATE_KEY` | 83, 84 |
| `compute-pinnacle-pack-ev` | `PINNACLE_PACK_EV_GATE_KEY` | 42 |
| `compute-golazos-pack-ev` | `GOLAZOS_PACK_EV_GATE_KEY` | 44 |
| `backfill-topshot-pack-supply` | `TOPSHOT_PACK_SUPPLY_GATE_KEY` | 15, 16 |
| `backfill-allday-pack-supply` | `ALLDAY_PACK_SUPPLY_GATE_KEY` | **none found** |
| `backfill-pack-opens-api` | `PACK_OPENS_API_GATE_KEY` | **none found** |

The 8 values were **distinct**, so per-function isolation was preserved rather than collapsing them onto one shared secret.

⚠ **The keys are in git history** (`git log -S` hits ~20 commits) and were mirrored into 5 committed docs. History rewriting is NOT worth a second `filter-repo` force-push — the 2026-08-03 purge already cost every pre-purge sha. **Treat all 8 as permanently burned; rotation is the only remedy.** The doc copies have been redacted at HEAD.

## What shipped (code only, inert)

- All 8 now read `Deno.env.get("<NAME>") ?? ""` and **fail CLOSED**.
- ⚠ Fail-closed needed an explicit guard, not just the env read: with an unset secret the constant is `""`, and a caller sending a bare `?key=` would have matched `"" === ""`. Every comparison now carries `if (!GATE || …)` (or `!!GATE && …` on the two OR-shaped gates).
- `compute-pinnacle-pack-ev`'s comment arguing the gate was "a low-risk cron identifier, not a high-value secret, so keeping it in source keeps INGEST_SECRET_TOKEN out of cron.job" was corrected — the second half is a real requirement, the first half was wrong, and an edge secret satisfies both.
- New `__tests__/edge-fn-no-hardcoded-gate-keys.test.ts` (6 tests, directory-driven so new edge functions are covered automatically) pins: no `rpc_pls_*` literal, no long literal assigned to a `*GATE|KEY|SECRET|TOKEN*` constant (one documented non-credential allowlist entry, itself checked for staleness), every `*_GATE_KEY` reader carries an unset-guard, and all 8 named functions actually got the treatment.

⚠ **The deployed functions are UNCHANGED and still work.** Nothing is broken right now. Edge functions do not auto-deploy from `main`.

⚠ **`edge-fn-drift.yml` (daily 06:40 UTC) will now report these 8 as drifted. That is correct — do NOT clear it by redeploying without first setting the secrets, or the 9 pg_cron jobs below go 403.**

## Rotation procedure

The ordering matters: the deployed code checks the OLD hardcoded key until redeployed, and pg_cron sends the OLD key until its commands are edited. Any single-phase rotation therefore has a window where the two disagree.

**Recommended (simple, short self-healing window).** All 9 jobs are idempotent and cursored, and run every 2–15 min except jobid 15 (daily) and 42/44 (6-hourly), so a few missed ticks self-heal. Do steps 2–4 back to back in one sitting.

1. Generate 8 new random keys (e.g. `openssl rand -hex 24` each). Do not reuse across functions.
2. Set the secrets:
   ```
   supabase secrets set ALLDAY_PACK_OPENS_GATE_KEY=<new> \
     TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY=<new> \
     PINNACLE_MINTS_GATE_KEY=<new> \
     PINNACLE_PACK_EV_GATE_KEY=<new> \
     GOLAZOS_PACK_EV_GATE_KEY=<new> \
     TOPSHOT_PACK_SUPPLY_GATE_KEY=<new> \
     ALLDAY_PACK_SUPPLY_GATE_KEY=<new> \
     PACK_OPENS_API_GATE_KEY=<new>
   ```
   (No effect yet — the deployed code does not read them.)
3. Redeploy the 8 functions.
4. Update the 9 pg_cron job commands to send the new `?key=` — jobids **15, 16, 20, 42, 44, 55, 56, 83, 84**. Use `cron.alter_job(<jobid>, command => …)`; re-read each command first, change only the `key=` value.

**Zero-downtime alternative** if you would rather not accept the window: add a second temporary secret read (`… ?? Deno.env.get("<NAME>_PREV") ?? ""`), set `<NAME>_PREV` to the current burned key, deploy, update pg_cron, then remove `_PREV` and redeploy. Two extra deploys to avoid a few self-healing missed ticks — probably not worth it here.

## Verification

- `select jobid, jobname from cron.job where command ~ 'key=' and command ~ '<fn-name>'` — confirm each of the 9 carries the new value.
- Watch `pipeline_runs` for the 6 pipelines with cron callers; a 403 shows as a failed run.
- ⚠ **`backfill-allday-pack-supply` and `backfill-pack-opens-api` have no pg_cron caller.** Their triggers are manual or on cron-job.org (which is not enumerable from the repo). After rotation, any saved manual invocation or cron-job.org entry for those two needs the new key, and there is no telemetry that will tell you if you miss one — check the cron-job.org console directly.
