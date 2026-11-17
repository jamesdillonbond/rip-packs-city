# The anon write-grant SET, diffed to membership at last — and the fifth object is dead residue

**Filed 2026-09-19 01:17Z (2026-09-18 6:17 PM PT) · Claude Code cloud · READ-ONLY, nothing shipped**

## Why this exists

Deep-audit run 5 (§10) re-ran the DB security half at 12:55 PM PT once the #122 outage cleared, and
found the anon write-grant count had moved **20 → 5**. It recorded the number and explicitly deferred
the rest:

> ⚠ Not re-derived to the object level this pass — **flagged for the next pass to diff the
> membership**, since a shrink is as much a set change as a growth and the register's row is now
> wrong either way.

This is that diff. ⭐ **A shrink on a security surface is not self-evidently good news** — it is a set
change, and until the membership is named nobody can say whether the right 15 left or the wrong one
stayed.

## The measurement

`information_schema.role_table_grants` for `grantee = 'anon'`, `privilege_type in (INSERT, UPDATE,
DELETE, TRUNCATE)`, schema `public`, resolved against `pg_policies`. Taken 2026-09-18 ~6:0x PM PT.

**The anon write-grant set is exactly 5 objects:**

| object | anon privileges | policy | verdict |
|---|---|---|---|
| `email_subscribers` | INSERT | `email_subscribers_anon_insert`, INSERT, `{anon}` | ✅ bounded — email shape + 6 length/cardinality checks |
| `funnel_events` | INSERT | `funnel_events_anon_insert`, INSERT, `{anon,authenticated}` | ✅ bounded — 5 length checks |
| `outbound_clicks` | INSERT | `anon_insert_outbound_clicks`, INSERT, `{anon}` | ✅ bounded — 14 length/range checks |
| `support_conversations` | INSERT | `anon_insert_support_conversations`, INSERT, `{anon}` | ✅ bounded — 16 checks, incl. `length(admin_note) = 0` |
| **`portfolios`** | **DELETE, INSERT, UPDATE** | `own_portfolio`, **`ALL`**, **`{public}`** | ⚠ **neutralised BY ACCIDENT — see below** |

⭐ **The row's standing conclusion ("all RLS-neutralised or shape-bounded") still HOLDS.** Four of the
five are deliberate, tightly-bounded, append-only telemetry/signup surfaces — exactly the shape the
register recorded. Nothing regressed.

## The finding: `portfolios` is the fifth, and it is residue

It is the only member with `DELETE`/`UPDATE`, the only one with `cmd = ALL`, and the only one granted
to `{public}` (so authenticated too). Its policy:

```
USING ((wallet_address)::text = ((SELECT current_setting('request.jwt.claims', true))::json ->> 'wallet'))
WITH CHECK (none — for cmd ALL, Postgres reuses USING as the check)
```

**It is not exploitable, and the reason it is safe is not the reason it looks safe.** The predicate
compares `wallet_address` to a **`wallet` JWT claim that nothing in this system sets**. For any anon or
authenticated caller the claim is absent, `->> 'wallet'` is NULL, the comparison is NULL, and RLS
denies. It fails closed — **by accident of a dead feature, not by design.**

Supporting facts, all measured the same instant:

- **`portfolios` holds 0 rows** and has 7 columns (`id, wallet_address, display_name, total_moments,
  last_synced_at, created_at, updated_at`).
- **Zero repo references.** `grep` over `app/ lib/ workers/ scripts/ supabase/` for the table (excluding
  `portfolio_moments` / `portfolio_snapshots`) returns nothing.
- **`portfolio_moments` holds 0 rows** and carries the only FK to it.
- ⚠ **But the name is NOT unreferenced in the DB** — and this is the part that makes a naive cleanup
  dangerous: `snapshot_all_user_portfolios()` mentions it, and pg_cron **jobid 490
  `rpc-portfolio-snapshot-retry`** (`17 11 * * *`, `postgres`, **5/5 ok in 7 d**, last run 2026-09-18
  11:17Z) is live.
- ⭐ **That lane is healthy and is NOT writing this table:** `portfolio_snapshots` holds **2,052 rows**,
  newest **2026-09-18 11:17:00Z** — written by that very tick. It works off `saved_wallets` (135) and
  the 28 real users. So the cron is fine; only `portfolios` itself is dead.

## ⛔ What I deliberately did NOT do

**I did not revoke the grant, and did not drop the table.** Both were tempting and both are wrong to do
unattended:

1. CLAUDE.md's revoke rule is explicit that `REVOKE … FROM PUBLIC, anon, authenticated` **orphans a
   pg_cron caller holding no explicit grant**, and it **fails as SILENCE** — `cron.job_run_details`
   shows it, `pipeline_runs` never does. There IS a live pg_cron job in this table's dependency
   neighbourhood, so the revoke needs the job's role checked and granted in the same migration.
2. A `DROP` is destructive SQL, which is on the never-auto-ship list.
3. The finding is **defence-in-depth, not a live hole** — nothing is reachable today. It does not earn
   an unattended security migration on a Friday evening.

## Proposed next step (small, for a pass that wants it)

Either (a) `REVOKE INSERT, UPDATE, DELETE ON public.portfolios FROM PUBLIC, anon, authenticated` in ONE
statement, having first confirmed via `has_table_privilege` that jobid 490's role (`postgres`) retains
what it needs — `postgres` is the table owner, so this is near-certainly a no-op for the lane, **but
verify rather than assume**; or (b) retire `portfolios` + `portfolio_moments` together as a Trevor
decision, since both are 0-row remnants of the removed portfolio feature and `snapshot_all_user_portfolios()`
would want its dead reference cleaned at the same time.

**Exit condition for either:** the anon write-grant set reads **4**, all INSERT-only, and jobid 490's
next tick still writes a `portfolio_snapshots` row. **Falsifier:** jobid 490 logs a permission error, or
`portfolio_snapshots` stops growing.

## Three other probes re-run while here (all owed, all clean)

- **PII over anon-readable surfaces** — the last owed run-5 DB probe. **None reachable.** 92 anon-SELECT objects carry a PII-shaped column; almost all are blockchain addresses (public on-chain facts here, not PII). Every genuine-PII holder — `mcp_api_keys`, `chat_sessions`, `stripe_payment_log`, `fmv_alerts` — has **service-role-only** SELECT/ALL policies, and `email_subscribers` has **no SELECT policy at all**, so anon holds the grant and reaches nothing. The six anon-readable `rls=false` objects are all **views with `security_invoker = on`**. ⚠ **One anon-reachable path to real PII exists that the register never named:** `support_conversations.anon_read_own_support` (SELECT, `{public}`) gates on `request.headers ->> 'x-session-id'` — **a client-supplied header as a bearer secret** — exposing `user_email` / `owner_key` / `user_wallet` for a matching `session_id`. The INSERT policy enforces `length(session_id) >= 20`, so it is defensible, **but it is a guessability argument rather than an authorisation one.** Recorded, not filed as a defect.

- **`cron.job.command` credential scan** — the register's known-blind corpus. Read REDACTED, never raw.
  **13 of 149 jobs carry a gate key in the URL** (12 active; the 13th is jobid 16, the documented
  `public-api.nbatopshot.com` pause). The 2026-09-02 reading was **14** — the class is unchanged and
  still exactly as the register describes it. **0 JWT literals, 0 `Bearer` literals** anywhere in
  `cron.job.command`.
- **pg_cron disabled/orphan invariant** — now **149 jobs / 147 active** (register row says 104 / 103).
  ⭐ **Both inactive rows have a ledger-recorded pause, so the invariant HOLDS:** jobid 16
  `rpc-backfill-pack-pool` (dead-host pause) and jobid 491 `rpc-ccm-step2-retry` (deactivated
  2026-09-13, migration `20260913173902_…`, register #108).

⚠ **The job population grew 104 → 149 in 16 days and no snapshot exists to diff the membership against**
— the register already records this gap twice ("the two removed jobs are now unnameable because no
08-15 snapshot exists"). **Naming it a third time: a periodic `cron.job` census, committed or captured,
is the only thing that closes it.** Not built here; it is new state and wants a deliberate owner.
