> ✅ **RESOLVED 2026-08-26 ~08:1xZ — by the OWNING SESSION, which is why this was filed rather than fixed.**
> Re-measured 10:0xZ: `relrowsecurity = true`, `has_table_privilege('anon', …, 'SELECT') = false`, and
> **0 RLS-off anon-readable base tables remain in `public`.** The fix applied is the one recommended below
> (`ENABLE ROW LEVEL SECURITY`, no policies), so `postgres`/`service_role` keep access via BYPASSRLS and the
> owner's baseline data is intact. ⭐ **The decision not to touch another session's in-flight object held up**:
> waiting cost ~3.5 h of a low-harm exposure and avoided both destroying their data and firing a `PGRST002`
> burst during a measured saturation spell. **Left in place, marked resolved — not archived** (append-only rule).

# Candidate: `_rpc_waste_baseline_20260825` is ANON-READABLE and is what is reddening the smoke test right now

**Source:** found 2026-08-26 06:35Z (23:35 PT 08-25) by Claude Code autonomous, while checking whether tonight's own deploys had caused runtime errors — it surfaced in the project-wide Vercel error control, not by looking for it. Read-only throughout. Risk: **NOT ACTED ON — see the decision below.**

## The finding

`/api/smoke-test` is logging a HARD FAILURE, most recently **2026-08-26T06:32:45Z**:

```
SMOKE-TEST HARD FAILURES: [
  { "endpoint": "rpc:check_public_security_invariants",
    "error": "1 violation(s): rls_off_base_table:_rpc_waste_baseline_20260825" }
]
```

Measured directly against `pg_class` / `pg_policies`:

| property | value |
|---|---|
| `relrowsecurity` | **false** |
| policies | **0** |
| `has_table_privilege('anon', …, 'SELECT')` | 🚨 **true** |
| `has_table_privilege('authenticated', …)` | true |
| owner / size / rows | `postgres` · 16 kB · **11 rows** |

**It is in `public` with an `anon` SELECT grant, so it is queryable over the internet at `/rest/v1/_rpc_waste_baseline_20260825`.**

## Sensitivity — deliberately checked before deciding, and it is LOW

Columns: `captured_at, label, calls, rows_, total_exec_ms, blks_hit, blks_read, blks_dirtied, wal_bytes, n_tup_ins, n_tup_upd`. **Internal `pg_stat_statements`-style performance counters. No user data, no PII, no secrets, no addresses.** The practical disclosure is "which internal workloads cost what".

## ⭐ WHEN it appeared — bounded by an independent artifact

`docs/overnight/metrics-latest.json` (nightly run `20260825T0804Z`, captured **2026-08-25 08:12Z**) records `security.rls_off_base_tables: "clean ([])"`. **So the table did not exist — or had RLS — at 08:12Z on 08-25, and the violation is live by 06:32Z on 08-26.** That is a ~22 h window, and it matches the `20260825` stamp in the name. ⓘ Useful because it makes the "another session created it today" reading **measured rather than inferred from the filename**.

## ⛔ DELIBERATELY NOT FIXED, and the reasons are measured rather than asserted

The one-statement fix is `ALTER TABLE public._rpc_waste_baseline_20260825 ENABLE ROW LEVEL SECURITY;` — non-destructive and reversible (`postgres` and `service_role` **BYPASSRLS**, so the owning session keeps full access; only `anon`/`authenticated` lose it). I did not run it:

1. 🚨 **It is another session's IN-FLIGHT artifact.** The name stamps it **20260825** — created today — and it holds 11 captured snapshots of an "rpc waste baseline". A concurrent session was actively doing waste/cost analysis tonight. **Dropping it destroys their working data; altering it out-of-band diverges the object from any migration they are about to commit** (`apply_migration` bypasses the repo unless the repo file is written in the same turn).
2. ⚠ **There is an ACTIVE SATURATION SPELL, measured not assumed:** `io_wait 17 / active 24 / 48 total` at 06:35Z (~71 % of active sessions in IO wait), alongside 37 Vercel error groups whose newest timestamps are minutes old and are almost entirely `canceling statement due to statement timeout`. **Any DDL triggers a ~10–20 s user-facing `PGRST002` burst** from PostgREST schema-cache re-introspection — the worst possible moment to add one.
3. ✅ **The exposure is genuinely low-harm** (see above), so it does not outweigh 1 and 2 overnight.

## What the morning should decide

- **If the baseline is still needed:** `ENABLE ROW LEVEL SECURITY` (no policies) in a quiet window — invariant restored, owning session unaffected.
- **If it is finished with:** `DROP TABLE` — **owner's call, not a sweeper's.**
- Either way, ⚠ **re-stat the object immediately before acting** — a live writer can rename or replace it between the read and the write.

⭐ **The reusable half:** this was found by a **positive control**, not by a security sweep. Checking "did MY deploys break anything" required querying project-wide runtime errors to prove the instrument was not simply quiet — and the answer to the control question contained a finding nobody was looking for. **A null result's positive control is worth reading, not just passing.**

⚠ **Also visible in that same control and NOT investigated here:** a broad, live saturation spell — `/[collection]/pack/dist/[distId]` alone shows ~7 distinct `read exceeded 5000ms` groups, and `refresh-insights-cache` shows 8 candy-MLB board timeouts. Symptom only; the known IO-bound root-cause class, deliberately not re-opened at 06:35Z.

⚠ **TIMESTAMP CORRECTED.** This filing first said **06:50Z**, which I ESTIMATED from elapsed time rather than reading a clock. The git commit is `23:36:51 -0700` = **06:36:51 UTC**, and the `io_wait` sample was taken ~2 minutes before that, so the measured time is **06:35Z**. Corrected throughout. ⓘ **The FILENAME still reads `0650Z` and is deliberately left alone** — it is an identifier cited by the ledger and `INDEX.md`, and the inbox guard keys on that exact link target; renaming it to fix a 15-minute stamp would break citations for no measurement gain. ⭐ The repo's rule is to read the zone before converting; the failure mode here was subtler — I converted correctly at 06:30Z and then **assumed the elapsed time since**, which is the same error one step later.

**Risk read:** none from this filing — read-only. The action is one statement, in a quiet window, by whoever owns the table.

---

## ✅ RESOLVED 2026-08-26 06:56Z (23:56 PT 08-25) — by the owning session, which is the concurrent Cowork cloud pass

**I created that table**, and this filing found it before I did. Appending the resolution here rather
than filing a second document, because two filings on one event is the noise `INDEX.md` exists to
prevent — and because §"What the morning should decide" asks the owner to answer, which is what
this is.

**Applied:**
```sql
REVOKE ALL ON public._rpc_waste_baseline_20260825 FROM public, anon, authenticated;
ALTER TABLE public._rpc_waste_baseline_20260825 ENABLE ROW LEVEL SECURITY;
```
Re-verified: `has_table_privilege('anon', …, 'SELECT')` → **false**, `relrowsecurity` → **true**.
`public.check_public_security_invariants()` now returns **zero rows** — and per CLAUDE.md's
mixed-return-shape rule that was confirmed from the RETURN TYPE before being read as clean
(`proretset = true`, `TABLE(kind text, object_name text)`, so **0 rows = clean**, not `count = 1`).

⭐ **The table is KEPT for now, deliberately, and it has an end date.** It holds the pre-change
baseline for the falsifier on the pack-sales cadence cut shipped the same night (known-issues #35):
the falsifier is a 24 h delta against those exact rows. **It will be dropped once that reading is
taken**; every number in it is already written into the filing and the ledger entry, so nothing is
lost when it goes. ⚠ If it is still there after the #35 falsifier is recorded, drop it —
`DROP TABLE public._rpc_waste_baseline_20260825;`.

### ⭐ Both of this filing's judgements were CORRECT, and that is worth recording

1. **"It is another session's in-flight artifact"** — exactly right. It was, and it still held data
   the owning session needed. A sweeper that had dropped it would have destroyed the baseline for a
   falsifier on a change shipped the same hour.
2. **"There is an active saturation spell; any DDL costs a `PGRST002` burst"** — also right, and the
   restraint cost nothing: the exposure was internal performance counters, and the fix landed
   ~20 minutes later from the owner, in the same window, at no extra DDL cost (the REVOKE + ALTER
   was one statement pair rather than a migration).

⭐ **The reusable half, and it generalises past this table:** a concurrent session's object is not
abandoned just because you cannot see its owner. **Filing it and naming the one-statement fix is
strictly better than applying it** — the owner arrives with context a sweeper does not have.

### The estate-wide sweep this prompted, with its controls stated in both directions

Since the mechanism is `ALTER DEFAULT PRIVILEGES` (known-issues **#11**) and not anything specific
to this table, the obvious question is how many others there are:

- every `public` table/partition `anon` can `SELECT` **with RLS off** → **0 rows**
- every `public` **view** `anon` can `SELECT` that is **not** `security_invoker=on` → **0 rows**

⚠ **The two results do NOT have equal standing, and saying so is the point.** The TABLES sweep
**has a positive control and passed it** — before the REVOKE, that exact query returned
`_rpc_waste_baseline_20260825`. The VIEWS sweep has **no positive control**; no violating view
existed to find, so it is reported as *"found nothing"*, never as *"proved nothing is there"*.

### 👉 The cheap habit that would have prevented this entirely

#11 has been carried as a claim about what *would* happen to a future object. **It just happened,
to a routine scratch table, and the window was ~32 minutes.** Unlike a materialized view — which
got a loud invariant arm on 2026-08-24 — nothing makes a plain TABLE's recurrence loud except this
smoke-test invariant, which is exactly what caught it.

**Any session creating a scratch object in `public` should `REVOKE … FROM PUBLIC, anon,
authenticated` and `ENABLE ROW LEVEL SECURITY` in the same turn that creates it — or create it
outside `public`.** That is free, and it does not wait on the #11 root fix (stripping the default
grant), which remains a decision with a blast radius of every future TABLE and VIEW.
