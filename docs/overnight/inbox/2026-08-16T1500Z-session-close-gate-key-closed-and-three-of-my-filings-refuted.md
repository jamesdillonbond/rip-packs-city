# Session close — 2026-08-15/16, Cowork cloud: the gate-key rotation item is closed, and three of my own filings were refuted

Spans 2026-08-15 ~13:00 PT → 2026-08-16 ~08:00 PT. **One prod change** (`cron.alter_job(42)`),
ledgered by Trevor in `b1763bf0`. Everything else read-only measurement.

## Shipped

| | what | verified by |
|---|---|---|
| **Pinnacle gate-key rotation** | `cron.alter_job(42)` onto a DB-generated key never selected into a transcript; Trevor set `PINNACLE_PACK_EV_GATE_KEY`; `_OLD` retired | **3 scheduled ticks** (00:17/06:17/12:17Z) all `ok=true`, 156 found / 97 written |
| `rpc-edge-fn-deploy.skill` | the only one of ten skills with no bundle | built, delivered, written to `docs/cowork-skills/` |

⚠ **There is no revert path for the old key** — it was never read, by design. The rollback is
forward: generate another and repeat.

## ✅ CLOSED — "gate-key rotation 3 of 8", open since 2026-08-11

Full detail in `2026-08-16T1455Z-gate-key-rotation-item-is-CLOSED-all-14-verified.md`. Summary:
all **14** jobs calling `/functions/v1/` validated in one query (length / `^rpc_pls_` / placeholder
regex / md5 grouping — **no value selected**). Zero missing, zero placeholders, all well-formed.
Positive control: **681 rows in `net._http_response`, `403` count = ZERO**, every one of the 14
having ticked inside that window. **Every gate is accepted.**

⛔ **The residual that would repeat the outage:** 11 of 14 still carry their original 21–28-char
keys. The 403 evidence proves *acceptance*, **not which secret accepted** — a gate takes `GATE` or
`GATE_OLD` and nothing in the DB distinguishes them. **Never delete a `*_GATE_KEY_OLD` without
re-pointing its cron and verifying a tick.** Jobs 25 and 29 share one key across two functions.

## Three of my own filings refuted — the substance of the pass

**1. `total_minted > 0` for the zero-supply dist.** Measured platform-wide before proposing it:
Golazos is **224 of 224** zero-minted (never populates the column), so it would have **erased the
entire Golazos pack surface**; all 10 Top Shot zero-minted dists are **<14 days old** — real
upcoming drops. And `dist_id '0'` has every EV field NULL, so there is **no correctness defect at
all**. Final call: don't ship a filter.

**2. "Move precompute leg 8 to ~07:00Z, which is 6-for-6."** The 06:58Z tick **failed the next
morning**. 5 of the last 6 ticks failed; the only survivor, 00:58Z, has gone 63 → 275 → 501 →
491 s over four days. A recommendation derived from a trend expires at the rate of the trend.

**3. "18 of 19 precompute rows are fresh — one stale leg, not a stale board."** True at 21:10Z on
08-15. Fifteen hours later **only 3 of 19 were under 8 h old**.

## The best find: `statement_timeout` does NOT re-arm after COMMIT

An existing memory asserted it does, and the shipped per-leg-COMMIT fix (jobid 222 function →
jobid **287** PROCEDURE `_p`, 8 COMMITs) was built on that. **Refuted by three runs:**

| tick | legs completed | total runtime |
|---|---:|---:|
| 00:58 | **8 of 8** | 491 s |
| 06:58 | 7 of 8 | **600.0 s** |
| 12:58 | **2 of 8** | **600.0 s** |

If the timer re-armed, the 06:58 run (7 legs over 532 s, then leg 8) would have reached ~1,130 s.
Both failures cap at exactly 600 s regardless of legs finished — `cron_heavy` is
`statement_timeout=600s` and **the whole `CALL` is one statement**. Per-leg COMMIT buys
**durability of finished legs, not a fresh budget.**

👉 **So the remedy is one cron job per leg** — each becomes its own top-level statement with its
own 600 s. This *reverses* the old memory's "one procedure, not seven cron entries", which was
right about durability and wrong about budget.

> ✅ **SHIPPED 2026-08-16 15:08Z (Claude Code, interactive)** — this filing said "Not shipped …
> Trevor's call", and it was applied during a "work through the tree" session. jobids **324–331**,
> monolith **287 unscheduled**; first split tick succeeded in 132.1 s. Record + one-block revert:
> `supabase/migrations/20260816150800_audit_20260816_trust_precompute_split_into_8_leg_jobs.sql`.
> Memory corrected: `commit-does-not-rearm-the-statement-timer`.

## Also filed

- **Nine orphan-looking edge functions**, not just `shared-deploy-probe`. Cleared on **3 of 4**
  scheduler surfaces (pg_cron + repo, which covers GHA and `vercel.json`); **cron-job.org
  unchecked** — operator console. Two non-discriminating shortcuts recorded so nobody repeats them.
- `fmv_sweep_wedge_hours` climbing **monotonically** 4.30 → 4.68 → 6.03 → **8.04** over 24 h.
  Earlier readings called it oscillating.
- Trust board is **5 breached**, not the 4 CLAUDE.md records.

## Traps hit and self-caught

- **`count(*)` over `check_edge_fn_http_failures()` returns 1 when CLEAN** — it returns a jsonb
  array, so one row containing `[]`. I read it as a failure before catching it a query later.
  Check the return type: jsonb-array checks are 1-row-clean, SETOF invariants are 0-rows-clean.
- **`cron.job_run_details` said `succeeded` for job 42's 18:17Z tick while `pipeline_runs` shows
  that run failing on the 21000.** It only knows the `net.http_get` dispatched.
- **A 200 from `compute-pinnacle-pack-ev` proves only the gate** — it returns
  `{"ok":true,"message":"queued"}` and works asynchronously. I waited for the `pipeline_runs` row.

## Still open (none blocking)

`ALLDAY_PROXY_URL` + rebuild · `/sessions` vhdx rename · the nine edge fns pending a cron-job.org
check · ~~precompute leg-split~~ (shipped 08-16, see above) · 17 inbox files · the memory fork
(`C:\Users\TDill\.claude` is outside the connected folders) · TopShot mega-wallet `getIDs()`
computation limit, still the item most at risk of being lost.
