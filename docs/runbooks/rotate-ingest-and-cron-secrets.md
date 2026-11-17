# Runbook — rotating `INGEST_SECRET_TOKEN` and `CRON_SECRET`

**Written 2026-08-22 (PT) after the second cron-job.org bearer exposure.** The rotation itself
needs operator credentials and is NOT something a session can do; this file exists so that when
it happens, the consumer list is already enumerated and the failure mode is already instrumented.

> ⚠ **Every number here is a DATED SAMPLE.** Re-derive before acting — the enumeration commands
> are given inline for exactly that reason.

---

## 0. The one fact that governs this rotation

**A 401 writes NO `pipeline_runs` row.**

That is stated in `app/api/cron/pinnacle-trades-indexer/route.ts:29` and it is true of every
gated route: the auth check returns before any logging. So a caller left holding the old token
does not appear as a *failure* — it appears as **silence**, which is indistinguishable from
"this cron was never scheduled."

Consequences, and they drive the whole procedure:

- **Do not verify a rotation by looking for errors.** There will not be any.
- **Do not verify it with `ok = false` counts, `last_error`, or the trust board.** All of them
  are fed by rows that a 401 prevents from existing.
- **Verify by ABSENCE**, using §4. Take the "before" snapshot *first* — it cannot be
  reconstructed afterwards, because `pipeline_runs` retains only ~73h.

This is the platform's own "an alert's output is silence, so the error is unfalsifiable" class.

---

## 1. Consumer enumeration (measured 2026-08-22)

Seven caller sources are possible on this platform. All seven were checked.

| # | Surface | Carries these tokens? | How it was checked |
|---|---|---|---|
| 1 | **Vercel env** | ✅ both | `INGEST_SECRET_TOKEN` + `CRON_SECRET` are the source of truth for **186 route files** that re-validate inline |
| 2 | **`vercel.json` crons** | ✅ `CRON_SECRET` | **38 entries**; Vercel injects `Authorization: Bearer $CRON_SECRET` itself |
| 3 | **GitHub Actions** | ✅ `INGEST_SECRET_TOKEN` | **16 workflow files / 26 references**, one repo secret. **Zero** use `CRON_SECRET` |
| 4 | **Cloudflare Workers** | ✅ `INGEST_SECRET_TOKEN` | **5 workers** hold it as a `wrangler secret` — see §2 |
| 5 | **cron-job.org** | ✅ (⛔ operator-only) | The exposed surface. **Cannot be read from a session** — see §3 |
| 6 | **pg_cron** | ❌ **NO** | Verified: of 106 active jobs, **zero** carry `authorization`/`bearer`; 14 call edge functions with a `?key=` **gate key**, which is a *different* secret |
| 7 | **Supabase edge functions** | ❓ unknown | ⛔ `get_edge_function` returns the full deployed source including live keys. **Not readable without leaking.** Treat as unverified |

### Re-derive commands

```bash
# 3 — GitHub Actions
grep -rno "secrets\.\(INGEST_SECRET_TOKEN\|CRON_SECRET\)" .github/workflows/ | sort -u

# 2 — vercel.json crons
node -e "console.log((require('./vercel.json').crons||[]).length)"

# 4 — Cloudflare workers
grep -rln "INGEST_SECRET_TOKEN" workers/*/index.ts workers/*/index.js

# 1 — routes that re-validate (they do NOT share a helper; each compares inline)
grep -rl "INGEST_SECRET_TOKEN\|CRON_SECRET" app/ --include=route.ts | wc -l
```

```sql
-- 6 — pg_cron. ⚠ NEVER select cron.job.command raw: it echoes live keys into the transcript.
SELECT jobid, jobname,
       (command ~* 'authorization|bearer') AS carries_auth_header,
       (command ~* '[?&]key=')             AS has_gate_key
FROM cron.job WHERE active ORDER BY jobid;
```

---

## 2. Cloudflare Workers — the surface most likely to be forgotten

⚠ **Pushing `workers/**` to `main` deploys NOTHING.** Each worker needs an operator
`wrangler secret put` **and** a `wrangler deploy`.

Holding `INGEST_SECRET_TOKEN` (verified 2026-08-22):

- `pack-events-ingest` — `index.ts:1873`
- `topshot-moments-hydrator` — `index.ts:381`
- `pinnacle-events-proxy` — `index.ts:100`
- `sales-counterparty-backfill` — `index.ts:223` (gates only the manual `fetch()` handler; the
  `scheduled()` path is ungated, so this worker will *appear* healthy through a broken rotation)
- `hybrid-custody-proxy` — holds the same **value** under a different **name**
  (`PROXY_SECRET` / `HYBRID_CUSTODY_PROXY_SECRET`). ⚠ A name-based grep misses it.

**Explicitly NOT shared** — do not rotate these together: `dune-proxy`, `helius-proxy`. Both
README files say the secret is independent.

---

## 3. cron-job.org — operator-only, and why

⛔⛔ **NEVER broad-read a cron-job.org job page.** The `Authorization: Bearer …` header is in the
**Common-tab DOM** — not behind "Advanced". This has leaked a live token **twice** (2026-06-19
and 2026-08-22), both times from a routine read.

To read a schedule without exposing the header, read **only** `input[type=text]`**[2]**
("Crontab expression"). Never `querySelectorAll('input')`, never a full `read_page`.

Updating the headers is an operator action in the browser.

---

## 4. The procedure

### Phase 0 — snapshot (MANDATORY, and it cannot be done retroactively)

```sql
-- Save this output somewhere outside the DB. pipeline_runs retains ~73h.
SELECT pipeline, count(*) AS runs_24h, max(started_at) AS last_seen
FROM pipeline_runs WHERE started_at > now() - interval '24 hours'
GROUP BY pipeline ORDER BY pipeline;
```

### Phase 1 — rotate, in this order

The order matters because Vercel is the *verifier* and everything else is a *caller*. Flipping
the verifier last minimises the window.

1. Set the new value in **Cloudflare** (5 workers) — `wrangler secret put` **+** `wrangler deploy`.
2. Set the new value in **GitHub** repo secrets (`INGEST_SECRET_TOKEN`).
3. Set the new value in **cron-job.org** (every entry carrying the header).
4. **Last:** set `INGEST_SECRET_TOKEN` and `CRON_SECRET` in **Vercel** env, then redeploy.
   ⚠ An env write alone does not take effect — Lambdas read env at deploy time.
   ⚠ A docs-only tip commit will not trigger a rebuild (`vercel.json` `ignoreCommand`); use the
   v13 deployments POST or touch a non-docs file.

⚠ **There is no dual-accept.** Verified 2026-08-22: no `INGEST_SECRET_TOKEN_OLD` /
`CRON_SECRET_OLD` path exists anywhere in the repo, and the 186 routes compare inline against
`process.env` rather than through a shared helper. **This is a flag-day rotation with a real
broken window between steps 1 and 4.** That is tolerable — these are cron/ingest lanes, not
user-facing surfaces, and they self-heal on the next tick — but it means §4 Phase 2 is not
optional.

### Phase 2 — verify by absence, ~1h after the redeploy

Run the **silence detector** (§5) and diff its result against the Phase 0 snapshot.
**Diff the SET, not the count** — a lane going silent while another recovers leaves the total
unchanged.

### Rollback

Put the previous value back in Vercel and redeploy. The other four surfaces can be left on the
new value only if the old one is restored everywhere; otherwise roll all five back together.
⛔ Rolling back means the exposed token is live again — do it only to restore service, and
re-attempt the rotation promptly.

---

## 5. The silence detector

Ready to run, no migration needed. **Developed and validated 2026-08-22 — the two earlier
versions were both wrong, and the reasons are worth keeping:**

- **v0 — fixed 6h window.** Flagged `pipeline-runs-daily-rollup`, a 6-hourly lane that had missed
  exactly one tick. A fixed window cannot judge a lane whose cadence is that window.
- **v1 — 3× MEDIAN gap.** Worse. The `wallet-backfill-*` lanes run in bursts, so their p50
  inter-run gap is **0 seconds** and any pause read as ~100,000× cadence. **7 of 12 hits were
  that artifact.**
- **v2 — 3× P90 gap, floored at 30 min.** p90 survives burstiness; the floor kills the rest.

```sql
WITH gaps AS (
  SELECT pipeline, started_at,
         started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at) AS gap
  FROM pipeline_runs
  WHERE started_at > now() - interval '72 hours'
),
stat AS (
  SELECT pipeline, count(*) AS runs_72h,
         percentile_cont(0.90) WITHIN GROUP (ORDER BY extract(epoch FROM gap)) AS p90_gap_s,
         max(started_at) AS last_seen
  FROM gaps WHERE gap IS NOT NULL
  GROUP BY pipeline HAVING count(*) >= 5
)
SELECT pipeline, runs_72h,
       round((p90_gap_s/60)::numeric, 1)                              AS p90_gap_min,
       round((extract(epoch FROM (now()-last_seen))/60)::numeric, 1)  AS silent_min,
       round((extract(epoch FROM (now()-last_seen))/NULLIF(p90_gap_s,0))::numeric, 1) AS silent_x_p90,
       last_seen
FROM stat
WHERE extract(epoch FROM (now()-last_seen)) > GREATEST(3 * p90_gap_s, 1800)
ORDER BY silent_x_p90 DESC NULLS LAST;
```

⚠ **What v2 is structurally blind to — state this, do not let it read as coverage:**

- **Lanes with fewer than 5 runs in 72h** (`HAVING count(*) >= 5`). They have no cadence to
  compare against and are excluded *by construction*.
- **Lanes that were already erratic before the rotation.** `topshot-active-listings-ingest` is
  16h silent right now and v2 does *not* flag it, because its p90 gap is already huge
  (`egress_blocked`, the open atlas-proxy item). The Phase 0 / Phase 2 **set diff** is what
  catches these — not this query.
- **A lane that keeps writing rows but stops doing work.** Silence is the only thing measured
  here. `rows_written = 0` is a separate, already-documented null instrument.
- **Anything whose caller is not instrumented into `pipeline_runs` at all** — notably the
  ungated `scheduled()` path in `sales-counterparty-backfill`.

**Positive control** (per the platform rule that a null result needs one): run the query with
`GREATEST(3 * p90_gap_s, 1800)` replaced by `0`. It must return many rows. If it returns none,
the instrument is broken, not the fleet healthy.

---

## 6. Related

- `docs/reference/cron-and-schedulers.md` — the four schedulers and `pipeline_runs` retention.
- `docs/reference/database.md` — security posture.
- Memory: `web-console-secret-safety`, `cloudflare-workers-do-not-autodeploy`,
  `edge-fn-deploy-blocked-by-unset-gate-key`, `cron-job-command-echoes-gate-key`.
