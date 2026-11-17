# The `pg_net_http_403` CRITICAL is ONE job, and the Pinnacle "deployed or ineffective?" question is closed

Claude Code, interactive, 2026-08-14 22:40 PT (2026-08-15 05:40Z). **Read-only: no deploy, no secret, no DB
write, no migration.** Written while committing the 08-14 overnight artifacts, which carry these two items as
open and both describe them as larger than they are.

Two queued items — the recurring **CRITICAL `pg_net_http_403`** and the **`compute-pinnacle-pack-ev` freeze** —
turn out to be blocked on **one missing credential**, and to resolve with essentially the same two commands.

## 1. The 403s are jobid 16 alone. Attribution is NOT blocked.

Both artifacts repeat that attribution is impossible (`net._http_response` has no URL column and
`net.http_request_queue` drains on completion). Measured live, it is decisive — the technique is set
membership over cron minutes, checked in **both** directions:

| candidate | 403s on its minutes | 403s NOT on its minutes |
|---|---|---|
| **jobid 16 `rpc-backfill-pack-pool`** | **71** | **0** |
| jobid 84 `rpc-pinnacle-mints-backfill` | 35 | 36 |
| jobid 25 `rpc-allday-pack-sales-backfill` | 24 | 47 |

`on = all` alone is weak (several jobs overlap any given minute); **`not_on = 0` is what excludes everyone
else.** Corroborated by rate, which is independent of timing: **71 403s / 5.98 h = 11.9/h** against jobid 16's
**72 runs** in the same window (every 5 min). Every other candidate runs at 30 / 20 / 15 / 6 / 4 / 2 / 1 per
hour and would have produced a visibly different count.

⚠ **The retention figure that justified giving up is wrong, and has now been wrong in three passes.** The
runbook says `net._http_response` retains "~1.6 h". Measured: **707 rows spanning 05:59:00**. The obstacle was
always query shape, not retention. *Measure the window before declaring it too short.*

So **"a different subset of the 14 gate-keyed jobs" is not what is happening — it is one job, and the same one
job since at least 08-13** (that pass measured 70/0 against this jobid). jobid **15** (`rpc-backfill-pack-supply`,
daily 08:15) calls the **same** edge fn `backfill-topshot-pack-supply`, so it is almost certainly 403ing too —
it just fires once a day and landed outside this 6 h response window.

### Blast radius is far smaller than CRITICAL implies — and that is the actionable part

`backfill-topshot-pack-supply` writes `pack_drop_pool` rows with **`pool_source='gql_historical'`**. Live:

- `gql_historical` — 9,316 rows, **newest `last_refreshed_at` 2026-08-12 03:33**, **0 refreshed in 24 h**. Frozen, exactly matching the recorded 08-12 onset.
- `gql` — 118,103 rows, newest **05:25 today**, **35,056 refreshed in 24 h** — written by `compute-topshot-pack-ev` / `compute-allday-pack-ev`, both healthy.

**The live pack pool is fine; only the historical backfill lane is dead.** A CRITICAL that has fired for days
over a lane whose sibling already covers the user-facing surface is exactly the arm that trains an operator to
skim the board — the cost this repo already paid for with `ufc_fmv_stale_hours`. Either unblock it (below) or
decide the historical lane is not worth a gate key and unschedule 15 + 16; **do not leave it CRITICAL and
unowned.**

## 2. Pinnacle pack-EV: "never deployed", NOT "ineffective" — and the method that said otherwise cannot work

The 08-14 monitor and the overnight pass both conclude the fix `bd53bb3a` "**never deployed or was
ineffective**" because it is **absent from the last ~20 Vercel production deploys**. The conclusion (do not
close it as resolved) is right; the reasoning cannot support it:

⚠ **`compute-pinnacle-pack-ev` is a Supabase EDGE FUNCTION. It can never appear in a Vercel deploy, deployed
or not.** Scanning Vercel deploys is structurally incapable of answering the question — it returns the same
"absent" for a deployed fix, an undeployed one, and a function that does not exist. Same shape as the
guard-scope lesson already in CLAUDE.md: *the derivation fixed the blast radius, and the absent/green result
proved nothing.*

**The cheap decisive discriminator is the fix's own telemetry.** `bd53bb3a` deliberately made the dedupe
COUNTED, adding `dist_dupe_count` to the `pipeline_runs.extra` payload:

```sql
SELECT ok, (extra ? 'dist_dupe_count') AS has_fix_field
FROM pipeline_runs WHERE pipeline='compute-pinnacle-pack-ev' ORDER BY started_at DESC LIMIT 10;
```

**All 10 most recent runs: `has_fix_field = false`.** The deployed code does not contain the field the fix
adds ⇒ **not deployed**. "Ineffective" is excluded outright, which matters because the two have completely
different remedies. Still 100% failing — 08-15 00:17Z the latest, identical `ON CONFLICT` error,
`rows_written` 0 throughout; last OK 2026-08-11 06:17Z.

*(Deliberately did **not** call `get_edge_function` to read the deployed version — it returns the full
`index.ts` including the hard-coded gate literal. A fact-shaped question does not justify a secret-shaped
answer, and `pipeline_runs` answered it for free.)*

## 3. Both are blocked on the same single credential

- **`compute-pinnacle-pack-ev`** — needs `PINNACLE_PACK_EV_GATE_KEY` set to the value jobid 42 already sends, then a deploy. Per `docs/handoff-2026-08-13-pinnacle-pack-ev-unblock.md` Fact 1 its gate currently **passes** (it writes `pipeline_runs` rows carrying a Postgres error from inside the handler — a 403'd fn writes no row at all), so the deploy is auth-neutral and the cron needs no repoint.
- **`backfill-topshot-pack-supply`** (jobid 15 + 16) — same shape, except its gate is currently **failing**, so its `*_GATE_KEY` must be set to the value the cron already sends before or with the deploy.

⚠ **Neither needs the "8 secrets as ONE window" rotation** the artifacts still cite. That warning has been
stale since `e66884f7` shipped dual-accept `_OLD` across all 8 gate fns (pinned at
`__tests__/edge-fn-no-hardcoded-gate-keys.test.ts:165`); rotation is safe **per job, at leisure** — and neither
of these is even a rotation, each is one secret set to the value already in flight.

**Why I did not do it — a genuine credential gap, re-verified on Trevor's own machine.** The prior handoff
established this from a cloud sandbox, so the premise deserved re-testing where the real repo lives:
`SUPABASE_ACCESS_TOKEN` is present but **empty**, there is no token in `.env.local`, the Supabase CLI is not
installed (`npx supabase` resolves 2.114.0, unauthenticated), and `~/.supabase` holds only telemetry — no
stored auth. The Supabase **MCP exposes no secrets verb**, so `deploy_edge_function` alone would ship the
env-var-reading build against an unset secret and convert a deterministic SQL failure into a 403 every tick.
**Operator: two commands each.** `--no-verify-jwt` is not optional — there is no `supabase/config.toml`, so a
bare deploy defaults `verify_jwt=true` and the gateway rejects the cron caller before the function's own gate
ever runs.

### ⚠ Corroborated independently, and it supplies two facts this file was missing

A concurrent session wrote `docs/cowork-skills/rpc-edge-fn-deploy/SKILL.md` minutes before this file (mtime
22:31 PT; **left unstaged — it is their in-progress work**, and `docs/cowork-skills/` is otherwise tracked).
It reaches the same place from forensics rather than attribution, which is the useful kind of agreement:

- **It dates the break to the minute** — `backfill-topshot-pack-supply` **v25 deployed 04:16:26Z on 2026-08-12** shipping the env-var gate while **`TOPSHOT_PACK_SUPPLY_GATE_KEY` was never set**; last successful write **03:33:08Z**. That is byte-for-byte the `gql_historical` freeze I measured from the other end (`max(last_refreshed_at)` = **2026-08-12 03:33**). Two independent methods, same job, same minute — so the secret name above is not a guess: it is **`TOPSHOT_PACK_SUPPLY_GATE_KEY`**.
- ⚠ **`--import-map supabase/functions/deno.json` is ALSO mandatory, and both this file's §3 and the 08-13 unblock handoff omit it.** There is no root `deno.json` and commands run from the repo root, so without it every deploy fails to bundle with `Relative import path "@supabase/supabase-js" not prefixed with / or ./ or ../` — the same root cause as the documented `edge-deno` CI bug. A deploy attempted with `--no-verify-jwt` alone will not work.
- It also states plainly what I concluded from the credential probe: **the Supabase MCP has no secrets verb, so step 1 is dashboard-only and can never be completed by an agent session.** Treat that skill as the procedure of record; this file is the attribution and the blast radius.

⚠ **And it draws the line I should not blur: "403s stopped" does NOT mean rotated.** Setting the gate key to
the value cron already sends restores service *with a credential that is burned in public git history*. Both
unblocks above are **service restoration, not rotation** — the rotation is done only when a request succeeds
with a key that was never public.

**Verification is unambiguous either way:** a fresh `pipeline_runs` row with `ok=true` **and**
`extra ? 'dist_dupe_count'` true (next tick `17 */6 * * *`); for jobid 16, `check_edge_fn_http_failures()`
reading `[]` and `gql_historical` rows moving off 08-12. If a gate were wrong you would instead see the row
**disappear entirely** — the two failure modes are trivially distinguishable, which is the whole point of
Fact 1.

## Not in scope / not done

- **Inbox not archived** (33 standing). Archival is the night pass's post-drain step; these are queued items, and archiving un-drained files would hide the queue. Left intact deliberately, even though the shell works in this session.
- `panini_sale_price_capture_dry_days` 17, `public_board_slow_count` 6, `unmapped_resolution_backlog_max` 254 — all three re-confirmed known/tracked classes by the overnight pass; nothing added here.
