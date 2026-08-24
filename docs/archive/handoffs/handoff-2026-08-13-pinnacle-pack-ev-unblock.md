# Unblocking `compute-pinnacle-pack-ev` — it is two commands, not an eight-secret rotation window

Claude Code, interactive, 2026-08-13 ~12:05 PT (19:05Z). Read-only analysis; **no deploy, no secret, no DB change.**

`compute-pinnacle-pack-ev` has failed **every tick since 2026-08-11 06:17Z** (measured now: 8 runs / **0 ok**
in 48 h, last 18:17Z today, always `upsert pack_distributions: ON CONFLICT DO UPDATE command cannot affect
row a second time`). Disney Pinnacle pack-EV has been frozen for two days.

**The code fix already exists and is on `main`:** `bd53bb3a` added `dedupeByConflictKey` to the
`pack_distributions` upsert (`supabase/functions/compute-pinnacle-pack-ev/index.ts:324`, importing
`../_shared/upsert-dedupe.ts`). Prod is running **version 18, updated 2026-07-18**, which predates it.

So the only thing between a two-day outage and a fix is a deploy — and the recorded reason not to deploy is
correct but **describes far more work than is actually required.**

## The recorded blocker, and why it overstates the job

The 08-13 ledger and the daytime pass both say: jobid 42 is one of D2b's five un-rotated functions, the repo
copy reads `PINNACLE_PACK_EV_GATE_KEY`, that secret is unset, the gate fails closed — so deploying alone
converts a deterministic SQL failure into **a 403 every tick**. Both then point at the standing runbook
instruction: *complete the rotation as ONE window — 8 `*_GATE_KEY` secrets + deploy the env-var fns +
repoint every pg_cron `?key=` together, because any subset reproduces the outage.*

**Every clause of that is true except the last one, and the last one is what has kept this parked.**

## Fact 1 — the gate is currently PASSING, and `pipeline_runs` proves it

A 403'd edge function writes **no `pipeline_runs` row at all** — that is the whole reason the
`pg_net_http_403` instrument had to be built. `compute-pinnacle-pack-ev` wrote **8 rows in 48 h**, each one
carrying a *Postgres* error from deep inside the handler.

⚠ **A function cannot fail on its own `pack_distributions` upsert without having passed its own gate first.**
So the cron's existing `?key=` **already matches** what deployed v18 accepts (v18 predates the D2
de-hardcoding, so it compares against a hardcoded literal).

## Fact 2 — therefore the secret has a known-correct value, and the cron needs no change

The repo version compares `?key=` against `Deno.env.get("PINNACLE_PACK_EV_GATE_KEY")`. Set that secret to
**the value jobid 42 is already sending** and the deploy becomes auth-neutral: same key in, same key
accepted, cron untouched.

```bash
# 1. read the value the cron already sends (jobid 42) — treat the output as a secret,
#    do not paste it into a chat, an issue, or a commit message
#    (⚠ SELECT command FROM cron.job echoes the live ?key= — see the note at the bottom)
# 2. set it as the edge secret, then deploy:
supabase secrets set PINNACLE_PACK_EV_GATE_KEY='<that value>' --project-ref bxcqstmqfzmuolpuynti
supabase functions deploy compute-pinnacle-pack-ev --no-verify-jwt --project-ref bxcqstmqfzmuolpuynti
```

⚠ **`--no-verify-jwt` is not optional.** There is no `supabase/config.toml` in this repo, so a bare
`functions deploy` defaults `verify_jwt=true` and the gateway rejects the cron caller before the function's
own gate ever runs — a second, different way to 403 every tick.

**Verification (next tick is `17 */6 * * *`):** a row in `pipeline_runs` with `ok = true`. If the gate were
wrong you would instead see the row *disappear entirely* and `check_edge_fn_http_failures()` pick up a new
403 — the two failure modes are easy to tell apart, which is the point of Fact 1.

## Fact 3 — even a real rotation does not need one atomic window

All **eight** gate functions read a second, transitional secret and accept either key:

```
gateKeyOk(k) = !!k && ((GATE !== "" && k === GATE) || (GATE_OLD !== "" && k === GATE_OLD))
```

Verified behaviorally across all 8 (`backfill-allday-pack-supply`, `backfill-pack-opens-api`,
`backfill-topshot-pack-supply`, `compute-golazos-pack-ev`, `compute-pinnacle-pack-ev`,
`ingest-allday-pack-opens`, `ingest-pinnacle-mints`, `ingest-topshot-pack-opens-history`) and already pinned
by `__tests__/edge-fn-no-hardcoded-gate-keys.test.ts` — *"accepts the outgoing key ONLY while its own `_OLD`
secret is set"* (line 165), alongside the fail-closed assertion and `executed === 8`.

⚠ **`compute-golazos-pack-ev` names its constants `GOLAZOS_CRON_KEY` / `GOLAZOS_CRON_KEY_OLD` rather than
`GATE` / `GATE_OLD`.** A name-based grep reports it as the one function missing dual-accept; it is not. Match
on the *comparison*, not the identifier — I filed that false finding against myself before re-checking.

So the correct rotation procedure is **per job, at leisure**: set `<X>_GATE_KEY_OLD` to the outgoing key, set
`<X>_GATE_KEY` to a new random value, deploy that one function, repoint that one cron `?key=`, then delete
`_OLD` (no redeploy needed). **The "any subset reproduces the outage" warning has been stale since
`e66884f7` shipped dual-accept.** It is still accurate for the pre-`e66884f7` world and for any function
where *both* secrets are unset — which is exactly the state jobid 42 is in now, and exactly why Fact 2's
one-secret path is the safe move rather than a shortcut.

## Why I did not do it myself

Setting a Supabase edge secret needs the CLI plus a `SUPABASE_ACCESS_TOKEN`; the Supabase MCP exposes no
secrets verb, the CLI is not installed (`npx supabase` resolves 2.114.0 but is unauthenticated), and there is
no access token in `.env.local`. That is a genuine credential gap, not a judgement call.

I also did not read the deployed source to recover the literal. `get_edge_function` returns the full
`index.ts` including the hard-coded gate, and a fact-shaped question does not justify a secret-shaped answer.

⚠ **New instance of that same trap, on a table nobody flags as sensitive:**
`SELECT command FROM cron.job` **echoes the live `?key=` gate literal** inside the `net.http_get` URL. Select
`jobid, jobname, schedule, active` and leave `command` out unless you specifically need it; to compare a key
without revealing it, use the md5-fingerprint method.

## Not fixed by this, and not the same problem

`pg_net_http_403` is **CRITICAL right now** (24 calls / 2 h). That is a *different* subset of the 14
gate-keyed jobs genuinely 403ing, and it is unaffected by the above — jobid 42's gate passes, so jobid 42 is
not one of them. Attribution remains blocked: `net._http_response` retains ~1.6 h and cannot be joined back
to a URL.
