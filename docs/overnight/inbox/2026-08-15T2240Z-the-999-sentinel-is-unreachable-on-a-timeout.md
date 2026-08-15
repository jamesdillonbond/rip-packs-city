# The trust-precompute 999 sentinel is unreachable on a timeout, and the fix is structural

**Filed 2026-08-15 22:40Z (15:40 PT), Claude Code interactive. Shipped a fix, measured the
consequence, reverted it in the same session. The DEFECT below is real and is now
deliberately unfixed — the remedy needs a scheduling change, not a code change.**

## The defect (established, not inferred)

All eight `rpc_thp_leg_*` functions carry an `EXCEPTION WHEN OTHERS THEN` handler whose
entire purpose is to write the **999 failure sentinel** when the leg cannot compute its
metric.

PostgreSQL: *"The special condition name OTHERS matches every error type **except**
QUERY_CANCELED and ASSERT_FAILURE."* A `statement_timeout` raises exactly
`query_canceled` (57014). Verified on this instance:

| probe | result |
|---|---|
| `WHEN OTHERS` against a raised 57014 | **did NOT catch** — escaped the handler |
| `WHEN query_canceled OR OTHERS` | caught it |
| `select * from rpc_trust_health_precompute where value = 999` | **zero rows, ever** |

So on the one failure mode this instance actually produces, the handler cannot fire. A
timed-out leg writes **neither** its value **nor** its sentinel: the row keeps its old
value *and* its old `computed_at`, the error propagates out of the leg, and
`rpc_trust_health_precompute_refresh_p()` aborts — **skipping every leg after it**.

`v_rpc_trust_health` exposes no per-metric age, so the board then publishes a stale number
as if it were current. Observed 2026-08-15: `topshot_impossible_parallel_serials` 15.3 h
old (leg 8 of 8) while the other seven were 3.2 h fresh. The 12:58Z tick died at an
*earlier* leg and cost every leg downstream of it.

The only thing that noticed is **`trust_precompute_max_age_hours`** (breach 13, read
15.14) — the arm installed 2026-08-09 to replace `ufc_fmv_pct_stale_30d`. It is doing
exactly the job it was installed for.

## Why the obvious fix is wrong

Changing the clause to `WHEN query_canceled OR OTHERS` was applied and reverted. Three
measurements, none of which I had before applying:

1. **A function-level `SET statement_timeout` does not bind statements inside the
   function.** `pg_temp` probe: 300 ms declared, `pg_sleep(5)` ran to completion. So the
   legs' declared `60 / 90 / 120 / 180 / 180 / 240 / 300 / 480 s` budgets are **all
   inert**. This is the *second* instance of that trap on 2026-08-15, after `8918307c` on
   the drain seeders — a declared per-unit timeout that looks governing and is not.

2. **The real budget is `cron_heavy`'s role-level `statement_timeout=600s`, shared by the
   whole `CALL`.** Legs 1–7 burned **517 s** (18:58:00 → 19:06:37); leg 8 needs ~78 s and
   got ~83 s. It died at the boundary, not on its own merits — it is stalest by
   **position**, so optimizing its query fixes nothing.

3. **After a cancel is caught, the timer is not re-armed.** Probe at
   `statement_timeout=500ms`: first `pg_sleep(3)` cancelled and caught, second
   `pg_sleep(3)` **ran to completion** — `TAIL_UNBOUNDED ran_for=3.50s`.

(3) is decisive. Catching the cancel buys a reachable sentinel at the price of running
every remaining leg **with no timeout at all**, holding a pooled connection on the 2 GB
instance whose saturation caused the timeout. plpgsql exposes no way to re-arm
mid-statement, so **no in-procedure variant keeps the benefit without the hazard**.
Trading a bounded failure for an unbounded one is the wrong trade.

## The structural fix (recommended, not taken)

**Give each leg its own top-level statement — eight `pg_cron` entries instead of one
orchestrator.** Then:

- each leg gets a fresh 600 s budget, so leg 8 stops dying because legs 1–7 were slow;
- one leg's timeout cannot reach another, which is the actual defect;
- `cron.job_run_details` names the failing leg directly instead of one opaque `CALL`;
- the inert per-leg `proconfig` values could then be **deleted** rather than left looking
  authoritative, or replaced with per-job role settings that genuinely bind.

Cost: 8 schedule rows instead of 1, and the legs no longer run in a guaranteed order
(they don't depend on each other, so this looks fine — **verify before relying on it**).

Leave `WHEN OTHERS` alone in that world: with one leg per statement, an uncaught cancel
fails only its own job, which is the honest outcome and keeps the bound.

⚠ **If anyone re-points this at "just catch query_canceled", re-read (3) first.** The
sentinel being unreachable is genuinely a defect; the catch is genuinely not the fix.

## Also worth keeping

- ⚠ `REVOKE EXECUTE … FROM PUBLIC` is **not sufficient** for a newly created function
  here. Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon` +
  `authenticated` as **explicit** acl rows a PUBLIC revoke does not touch — measured
  `has_function_privilege('anon', …) = true` and `check_secdef_anon_exec_drift()` **0 → 1**
  right after apply. Revoke **both** halves, and verify with `has_function_privilege()`,
  never by reading the acl text: the PUBLIC row was gone from `proacl` while the function
  was still anon-executable.
- ⚠ `rpc_trust_health_precompute_refresh` (no `_p`) is a **13,009-char monolith with zero
  callers** — 0 DB functions, 0 cron rows, 0 views, nothing in-repo outside migration
  history. It is the name you would guess, it is 26× the size of the real one, and in it
  `impossible_parallel` is **leg 1** rather than leg 8 — i.e. reading it yields the
  opposite conclusion. **Read `cron.job.command`; never infer the callee from the name.**
  Candidate for deletion in the same window as the scheduling change.
