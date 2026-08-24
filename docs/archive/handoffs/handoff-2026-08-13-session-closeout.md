# Session closeout — 2026-08-13 (Claude Code, interactive, Trevor's box)

**Thread being archived. This is the pickup point for the next Cowork session.**
Tip at close: `217eeece`. Tree clean, `main` in sync, CI green, migration parity **clean**.

Read this first, then `docs/overnight/ledger.md` (top ~7 entries are this session).

---

## 1. What shipped — 12 commits, all CI-green

Four defects, all the same family: **a pipeline that reports success while doing nothing.**

| what | state |
|---|---|
| **Top Shot catalog walker** — `fetchEditionsPage` returned `… \| null`, collapsing "no editions" and "couldn't ask" into one value | ✅ shipped + deployed |
| **`compute-pinnacle-pack-ev`** — one duplicated `dist_id` aborted the whole batch (`21000`), skipping the EV write too | ⚠ **committed, NOT deployed** (§3) |
| **`ingest-allday-pack-opens`** — `if (!tip) return … 200` sat *outside* the try | ⚠ **committed, NOT deployed** (§3) |
| **wmc propagation logging** (`0003…patch`, landed via `git am`) | ✅ shipped |

Plus: **6 prod migrations recovered byte-exactly** (parity 6 → 0), a **cron wrapper** so the catalog
walker is scheduled at all, **2 prod suppressions**, and **2 stale remote branches deleted**.

### The three findings worth carrying

1. **The catalog walker was never on a cron.** Its header claimed "daily at 4am ET (cron-job.org)";
   it had **4 lifetime `pipeline_runs` rows, all manual**. So "description coverage isn't growing"
   had a *scheduling* cause underneath the query bug. Now on `/api/cron/topshot-catalog-backfill`
   (Vercel `12 2 * * *`, crons 37→38). ⚠ **Never point a `vercel.json` entry at the admin route** —
   it accepts only `RPC_ADMIN_TOKEN`, Vercel cron sends only `CRON_SECRET`, and a 401 writes no
   `pipeline_runs` row, so it would be indistinguishable from never being scheduled.
2. **Migrations can be recovered without transcription.** `query_sql(text) RETURNS jsonb` is
   service-role-executable; `execute_sql` returns `void` and cannot do it; the
   `supabase_migrations` schema is not in `public` so PostgREST can't read the table directly.
   A local Node script + `.env.local` → **6/6 byte-exact vs prod md5**. Memory:
   `mcp-apply-migration-bypasses-repo`.
3. **`ok` must not redden on every fault.** The walker's new `ok` flips on an upsert error or on
   **every walked set faulting** — not on a single one. A chronically-red pipeline trains the
   operator to skim, which this repo has already paid for twice.

---

## 2. Corrections made this session (read before trusting older notes)

- ⚠ **My jobid-16 403 "attribution" was NOT new.** `inbox/2026-08-12T1354Z-…` had it a day earlier
  by the same minute-fingerprint method. I investigated without reading the inbox first — exactly
  the trap the register warns about. Both artifacts now carry the correction banner up front.
- ⚠ **The weekly sweep misattributed the stale schema counts to `schema-truth.md`.** They are in
  **CLAUDE.md**; grep finds neither number in `schema-truth.md`. A pass sent to regenerate that file
  would have found nothing and left the figure stale. Now 367 tables / 134 views (live 08-13).
- ⚠ **I misread `ingest-allday-pack-opens`'s catch block** as returning 200 without logging and
  called it decisive. It **does** call `logRun`. Recorded in the inbox so it isn't inherited.
- **`b1018e63` already fixed the `description`-on-`Play` query** before I got to it; I dropped my
  duplicate and kept only the missing half (the fault distinction + the depth regression test).

---

## 3. ⛔ Blocked on the operator — nothing agent-side left

**a. Gate-key rotation.** `jobid 16` (`rpc-backfill-pack-pool`) is 403ing **288×/day**, and it is one
of the three functions D2b records as ✅ *rotated + verified* — **so the rotation regressed since
08-10**. Anything auditing D2b from the handoff will wrongly read 15/16 as done.

⚠ **Three committed fixes are deliberately undeployed behind this** — deploying any of the five
un-rotated functions alone turns a working fn into a 403 on every tick. Memory:
`edge-fn-deploy-blocked-by-unset-gate-key`.

✅ **The rotation IS safe to run in pieces** since `e66884f7` added dual-accept — the old
"any subset reproduces the outage" warning is stale. Set `_OLD` → deploy → repoint cron one job at
a time → delete `_OLD`.

**b. `ALLDAY_PROXY_URL` → `<topshot-proxy-host>/allday-consumer`.** Diagnosed conclusively against
the worker source (not guessed) — all three checks the filing demanded now resolve and agree:
`allEditions` is a consumer-endpoint op; the consumer host serves a reduced schema to
non-browser-fingerprinted requests and **only `/allday-consumer` adds that fingerprint**; and
`editions-hydrate` sends a non-browser UA, which is what earns the HTML `<title>block</title>`.
⚠ The code's fallback when the var is unset is the **bare** consumer host, which **can never work
from a Vercel lambda**. Until this changes, AllDay `editions.description` cannot populate, so
narrative search is Top Shot only. Pass condition: probe arm goes `conclusive: true`.

**c. Two `wrangler deploy`s** — `rpc-mcp-proxy` (its stale tool description is telling every LLM
agent that a working RPC is broken) and `atlas-proxy` (inert; would fix
`topshot-active-listings-ingest`, 68% `egress_blocked`).

**d. Stale persistent Windows env var `SUPABASE_ACCESS_TOKEN`** (44 chars) — silently defeats
`supabase login`. System Properties → Environment Variables.

**e. Cowork `/sessions`** — see §5.

---

## 4. Open, characterised, NOT guessed at

- **`rwfd_state` is going BACKWARDS** (10h27m → 4h57m converging → 6h14m losing ground), correlated
  with jobid 303 starting but **not isolated** (jobid 302 writes the same table). ⚠ The fix is a
  **pair**: self-tuning *alone* picks chunk 5 under the route's 30s budget — *smaller* than
  drift_active's current 25 — so it would run **slower**. Self-tune **and** move to `cron_heavy`,
  or leave it. Wants a quiet window and a measured before/after, not a blind stack on an
  IO-starved instance.
- **jobid 55** (`rpc-allday-pack-opens-backfill`) delivers **11 of 144 expected runs/24h**. Three
  lanes closed so you don't re-walk them: dispatch is fine (143 succeeded / 1 failed), it is **not**
  a 403 (its minutes carry zero — all 72 belong to jobid 16), and it is **not** a pg_net timeout
  (jobid 83 shares its exact minute slots and delivers 12/12). Next probe: once the tip fix
  deploys, `tip_unreachable` rows either appear (cause found) or don't (instrument the walk body).
- **No instrument watches wmc propagation health.** It took a `TABLESAMPLE` to see a 10-hour
  outage. A per-collection "% of wmc rows deviating >25% from `fmv_current`" trust arm would catch
  the next one.
- **Register:** ~17 open. D2b is the only P0. D3b and D13b are the live threads behind it.

---

## 5. Cowork `/sessions` — the runbook's Step 1 is probably wrong

⚠ **"Archive old sessions" is an UNVERIFIED assumption.** The recovery doc labels its own mechanism
as inference and says "I cannot see `/sessions` to confirm". **Nobody has ever run `df -h /sessions`.**

**Trevor's evidence falsifies it:** almost every session he started was already archived, and it
still failed on the 6th consecutive night. Either archiving doesn't reclaim, or interactive
sessions were never the bulk — probably both.

**Scheduled tasks are almost certainly the bulk.** `rpc-nightly-autonomous-pass` runs typecheck +
CI ⇒ **~0.9 GB × ~30/month**; the monitor adds ~180–240 lighter sessions. Interactive sessions are
rounding error. The runbook says target "sessions that ran builds or tests" — that IS the nightly
pass, not Trevor's.

**First thing any session with a shell should run, and ledger the output:**

```
df -h /sessions && du -sh /sessions/* | sort -h | tail -30
```

Durable fixes live in **Cowork → Scheduled**, not this repo: clone to `/tmp` (proven 08-05, 08-07),
`rm -rf node_modules` at end of run, or skip `npm install` on read-only passes.
Memory: `cowork-sessions-volume-archive-unverified`.

---

## 6. Not lost, but not landed

`2026-08-12T0530Z-silence-is-real-scope-decision.md` still is **not** in
`docs/overnight/inbox/`. Its content lived in a different thread and is nowhere on disk here, so I
could not copy it. It exists in the Cowork Project as
`claude/decision-silence-is-real-scope-2026-08-12.md` — paste it and it lands in one commit.

Also deliberately **kept**: remote branches `claude/todo-implementation-qi4350` and `-e4tib3`.
**5 of their 6 commits are genuinely absent from `main`** by subject search (a Deposit-scanner
retirement chore, the Panini price-capture operator handoff, the unmapped-backlog resolver-reason
spec, a focus note, a Panini serials-persistence implementation). Trevor's call, not cleanup.

---

## 7. Health at close

Security invariants **0**, secdef drift **0**, anon-write surface **0**, RLS-off **0**.
`tsc` clean, migration parity clean, tree clean.

**8 active alerts, all named:** `pg_net_http_403` (§3a) · `compute-pinnacle-pack-ev` (fixed, awaiting
deploy) · `topshot-active-listings-ingest` (§3c) · `allday-pack-opens-backfill` (§4) ·
`unmapped-sales-nfl_all_day` (D37, known) · `topshot-moments-hydrator` (info, marginal) ·
`allday-unmapped-resolver-tail` + `wallet-username-resolver` (saturation timeouts).

**Two alerts cleared this session by suppression**, each recorded with its *predicate* rather than
its conclusion, because the 08-11 outage was missed by five monitor runs applying a label whose
predicate was false: `allday_sales_v1_backfill` (the missed **fifth** spork-floor twin — cursor
verified at *exactly* 137390146, parent 25/25 ok) and `sync-nba-projections` (D28's sanctioned
lever, **time-boxed to 2026-10-14**, not permanent).

⚠ Panini light coverage self-resolved (45 runs/24h, walk landed 08:15 PT). The real cause was the
laptop asleep through six wake-ups, not the runner — check sleep settings, not
`scripts/ingest-panini-runner.mjs`.
