# RESOLVED — the pack-opens "spork stall" was a 403 auth outage across 7 pg_cron jobs

Claude Code, interactive, 2026-08-11 ~20:30 PT (2026-08-12 03:30Z). **Shipped + verified live.**

⛔ **This supersedes the pack-opens candidate in FOUR monitor files.** Their shared conclusion —
spork-proxy / Flow access-node unreachability — is **wrong**, and nothing needs doing about spork.
Do not re-open that lane.

- `2026-08-11T0610Z-daytime-monitor.md` Candidate 1 ("both spork-routed pack-opens walks STALLED…
  check spork-proxy reachability / `SPORK_PROXY_URL` / mainnet24 access node")
- `2026-08-11T1512Z-daytime-monitor.md` ("persisted and worsened … strengthens that candidate's
  not-a-transient-blip read")
- `2026-08-11T1809Z-daytime-monitor.md`
- `2026-08-11T2112Z.md` Candidate 1 (HIGH) ("pull the edge fn logs … check the spork-proxy / Flow
  access-node reachability the 403s imply")

## What it actually was

The **2026-08-09 D2 security change** (`b4e46435`, ledger 2026-08-09) de-hardcoded 8 edge-function
gate keys from `const GATE = "rpc_pls_…"` to `Deno.env.get("<NAME>") ?? ""`. Its own ledger entry
warned, verbatim:

> ⚠ **NOTHING IS BROKEN AND NOTHING IS FIXED IN PROD YET.** … **Do NOT clear it by redeploying
> without first setting the secrets, or 9 pg_cron jobs (15, 16, 20, 42, 44, 55, 56, 83, 84) start
> 403ing.**

On **2026-08-11 ~03:09–03:22Z** the `?key=` values in the pg_cron commands were rotated to new hex
secrets — but the edge functions were never redeployed and the Supabase secrets were never set. The
deployed copies still expect the original literals. **Half a rotation.** Every affected job began
returning `403 {"error":"forbidden"}`.

## Why nothing caught it (the actually-interesting part)

1. **`cron.job_run_details` said `succeeded`** — for a `net.http_get`, "succeeded" means the request
   was *dispatched*, not that it worked. ([[pgnet-http-response-is-the-edge-fn-instrument]])
2. **The function never ran, so it wrote NO `pipeline_runs` row.** Every silence-based check
   therefore saw the same shape as a completed no-op walk.
3. **`detect_stalled_pipelines()` DID fire** — and all four monitors dismissed it as *"documented
   no-op-walk false positive."* That annotation is real but applied to the **TopShot** walk
   (cursor 61,808,846, genuinely below the 65,264,619 spork floor → `done:true`). It was
   **misapplied to AllDay**, whose cursor at 85,940,403 is ~20.7M blocks ABOVE the floor and was
   mid-walk.
4. **Nothing in the estate read `net._http_response`.** 100 of 194 responses were 403 and no check
   looked. That is now fixed (below).

## Verification that settles it

Two `mode=probe` (read-only) calls to the SAME live function:

| key sent | result |
|---|---|
| the cron's rotated hex | **403 `{"error":"forbidden"}`** |
| the deployed gate literal | **200 OK** — scanned to tip `161083198`, found + resolved a live pack open |

Flow/spork reachability is perfect. It was purely auth.

## Shipped

**7 pg_cron jobs repointed to the gate literal each deployed function still expects** (jobids
preserved, schedules and all params unchanged):

| jobid | job | pipeline impact |
|---|---|---|
| 20 | `rpc-allday-pack-opens-forward` | **real loss** — new AllDay pack opens |
| 55 | `rpc-allday-pack-opens-backfill` | **real loss** — historical walk, ~20.7M blocks still to go |
| 83 | `rpc-pinnacle-mints-forward` | **real loss** — Pinnacle mints, ~17 rows/tick |
| 84 | `rpc-pinnacle-mints-backfill` | **real loss** — ~8–35 rows per 2 min |
| 56 | `rpc-topshot-pack-opens-history` | none (walk genuinely complete) — canary restored |
| 16 | `rpc-backfill-pack-pool` | pack drop-pool refresh |
| 15 | `rpc-backfill-pack-supply` | daily pack supply |

**Verified live** — first telemetry in 24 h, all `ok=true`:
`ingest-pinnacle-mints-forward` 17 rows · `ingest-pinnacle-mints-backfill` 8 rows ·
`allday-pack-opens-forward` 8 rows (cursor 160,980,787 → 161,030,787) ·
`topshot-pack-opens-history-backfill` `rows_found=0` (correct — below floor).

**New detector** (`audit_20260811_edge_fn_http_error_arm_and_candy_treasury_crosscheck`):
`check_edge_fn_http_failures()` flags 4xx on pg_net-dispatched edge functions and is wired into
`get_pipeline_alerts()` (the live Telegram/email path) via RENAME + thin wrapper — the original
11,383-char body was never retyped. Scoped to **4xx only**: a 4xx is unambiguously a
misconfiguration, whereas 5xx and pg_net's 55 s timeouts are routine upstream noise. It fired
correctly on the live outage (109 × 403, `critical`) — a real positive control, not a synthetic one.

## ⚠ STILL OWED (operator — I cannot set Supabase secrets)

The rotation is now **reverted to the pre-rotation literals, which are PUBLIC** (they are in this
public repo's git history — that is exactly why D2 rotated them). Service is restored and no NEW
exposure was created (the deployed functions already accept these values), but **the rotation is
still owed**:

1. `supabase secrets set` the 8 `*_GATE_KEY` values (`ALLDAY_PACK_OPENS_GATE_KEY`,
   `TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY`, `PINNACLE_MINTS_GATE_KEY`, `PINNACLE_PACK_EV_GATE_KEY`,
   `GOLAZOS_PACK_EV_GATE_KEY`, `TOPSHOT_PACK_SUPPLY_GATE_KEY`, `ALLDAY_PACK_SUPPLY_GATE_KEY`,
   `PACK_OPENS_API_GATE_KEY`) to fresh values.
2. Deploy the repo (env-var) versions of those functions.
3. **In the same window**, repoint the pg_cron `?key=` to the new values.

Doing (1)+(2) without (3) — or (3) without (1)+(2) — reproduces this exact outage. That is what
happened here. The new `edge_fn_http_error` arm will now page within minutes if it recurs.

## Separately noted, NOT fixed

- **jobid 44 `rpc-compute-golazos-pack-ev`** carries a literal key (never rotated) yet
  `compute-laliga-pack-ev` has been silent ~22 h. **Different cause** — not part of this outage.
  Worth a look.
- `backfill-allday-pack-supply` + `backfill-pack-opens-api` have **no pg_cron caller at all**
  (per the D2 entry) — un-enumerable, no telemetry. Unchanged here.

## ⓘ A FIFTH dismissal, written during this very session — the sharpest evidence for the new arm

`2026-08-12T0309Z.md` (20:09 PT, ~20 min before this fix landed) dismissed it again, twice:

> "jobs 55/56 pack-opens fire every tick — 18 & 12 runs/3h — the `cron_silent` is the documented
> post-floor no-op-walk that stopped writing `pipeline_runs` rows, **verified directly against
> `cron.job_run_details`**, not a scheduler stop"

> "`allday_pack_opens_forward` … cursor_stalled = AllDay backfill/primary-market wind-down (AllDay
> ended primary pack sales, so **no new forward activity is expected**)"

Both are wrong, and instructively so:

- `cron.job_run_details` is **the one instrument that cannot see this failure.** "Fires every tick"
  and "18 & 12 runs/3h" are counts of *dispatches*, every one of which returned 403. Citing it as
  verification is the trap, not the check.
- "No new forward activity is expected" is disproved on the first repaired run: the forward walk
  immediately found **3 opens and wrote 8 rows**, and has kept finding them. AllDay ended *primary
  pack sales*; **pack OPENS continue** and are a different event.

Five independent runs reached the same wrong conclusion because every signal available to them was
consistent with the benign explanation. That is exactly the gap `check_edge_fn_http_failures()`
closes — it reports the 403 directly instead of leaving silence to be interpreted.

## Final verification — all 4 pipelines recovered, and spork is explicitly proven healthy

The AllDay **backfill** was the last to confirm, because it takes >90 s (full 25k-block window through
spork-proxy) so pg_net always records `Timeout of 90000 ms` while the function runs on and logs
later — that is its normal shape, not a fault. Forced with `&blocks=500`:

```
{"mode":"backfill","start":85939903,"end":85940402,"opens":34,"pulls_written":331,
 "cursor_after":85939903,"queries":2,"scan_err":null,"resolve_err":null,
 "spork_available":true,"routed":"spork"}
```

HTTP **200**, cursor advanced 85,940,403 → 85,939,903 (descending, correct), `pipeline_runs` row at
03:38:27Z. **`spork_available: true` / `routed: "spork"`** — the spork-proxy path is healthy and was
never implicated. Final state: `check_edge_fn_http_failures()` returns `[]`; `get_pipeline_alerts()`
back to 9 alerts, all known-class.
