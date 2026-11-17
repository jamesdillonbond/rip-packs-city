# 86 anon-executable SECURITY INVOKER functions are invisible to `check_secdef_anon_exec_drift()`

Filed 2026-08-16 19:10Z (12:10 PT) by Claude Code. Found while auditing pack
machinery; the two-function slice with a measured cost was fixed and applied
(`audit_20260816_revoke_anon_exec_on_zero_caller_pack_fns`). **The class is not
swept and needs a decision.**

---

## The gap

`check_secdef_anon_exec_drift()` — the standing guard on "what can anon call?" —
considers **SECURITY DEFINER** functions only. Measured live:

```sql
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and not p.prosecdef and p.prokind = 'f'
   and has_function_privilege('anon', p.oid, 'EXECUTE');
-- 86
```

**86 anon-executable INVOKER functions**, none of which that check can ever
report, however often it runs green. This is the guard-scope class CLAUDE.md
already documents three times over (the anon driver-message guard deriving its
file set from `isPublicPath`; `insights-gate-include-completeness` walking
`INSIGHTS_DIR`; the scheduled-SECDEF-writer sweep whose verb list omitted
`refresh materialized view`). **Ask what a passing probe is structurally silent
about.**

## Why it is not automatically a breach — and why it is not automatically fine

A SECURITY INVOKER function runs as the **caller**, so anon's own RLS applies and
it cannot leak anything an anonymous visitor could not already read. That is why
this is not filed as a confidentiality P0.

What it *can* be is **unauthenticated compute amplification**, and one instance
was measured at a genuinely serious level before being revoked:

| | |
|---|---|
| `compute_pack_ev_from_pool_tier_weighted` | **45,762 ms**, **2,285,769 buffers (~17.4 GB)** per call |
| callers in product | **zero** (repo, `pg_proc.prosrc`, `cron.job` all 0) |
| reachable by anon | **yes** — `SET LOCAL ROLE anon` probe returned a result, not a denial |

On a 2 GB disk-IO-budgeted instance — already saturated when this was found (39
active backends, 27 on IO waits, `fmv-recalc` killed at `maxDuration` on ~63–75%
of invocations) — a handful of concurrent calls to that one function is a full
outage from an unauthenticated client, for free.

**So the risk is per-function and is a COST question, not a permissions question.**
That is exactly what makes a blanket sweep the wrong move.

## What NOT to do

⚠ **Do not mass-revoke all 86.** Many are legitimately anon-reachable and
load-bearing — the platform's public surfaces call invoker functions by design,
and CLAUDE.md already records the specific trap: `serial_fmv_estimate` **must**
stay anon-executable because it is reached through
`get_wallet_moments_with_fmv` and the anon-readable
`topshot_underpriced_serials_board` view. A direct-caller sweep is not sufficient
evidence to revoke, because an invoker function or an `security_invoker=true`
view executes its callee **as the caller** — so an anon-reachable view keeps an
anon grant load-bearing even when every *code* caller is service-role.

⚠ **Do not widen `check_secdef_anon_exec_drift()` to cover invoker functions
without a cost model.** It would immediately report 86 rows, most of them
correct, and a check that is 86-red on day one gets allowlisted wholesale — the
cry-wolf outcome this repo already paid for with `ufc_fmv_stale_hours`, and the
same failure as the 07-20 baseline that "accepted 49 rows under one bulk note and
an unauthorized writer rode along inside it."

## Suggested shape (not taken)

Rank the 86 by **measured cost**, not by name, and act only on the expensive tail:

1. For each, get a cost estimate cheaply — `pg_stat_statements` where the function
   already appears, or a single `EXPLAIN (ANALYZE, BUFFERS)` on the largest
   realistic argument. (⚠ Budget this: the measurement itself cost ~46 s of a
   saturated instance for one function.)
2. Cross-reference callers **including invoker-mode ones** — other invoker
   functions and `security_invoker=true` views, not just literal `.rpc("name")`
   in the repo, and not just `.rpc(literal)` (sweep dynamic `.rpc(var)` and direct
   `/rest/v1/rpc/` fetches too).
3. Revoke only where **expensive AND zero-caller** (the slice already done), or
   **expensive AND service-role-only in practice**.
4. Anything genuinely anon-reachable and expensive is a different fix — a bound,
   a cheaper plan, or a cached surface — not a revoke.

A useful smaller deliverable would be a trust-board arm on the *count* of
anon-executable invoker functions whose measured cost exceeds some threshold,
so the population cannot grow silently. That needs step 1 to exist first.

## Also worth knowing

⚠ **Revoke BOTH halves in one statement.** This DB carries
`ALTER DEFAULT PRIVILEGES` granting EXECUTE to anon + authenticated on new
functions in `public`, so a `FROM PUBLIC` revoke leaves explicit acl rows behind —
and the converse is equally true. Use
`REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated;` and verify with
`has_function_privilege`, never by reading `proacl` text (the 2026-08-15 drift was
introduced by a migration whose acl text looked clean).

⚠ **A prefix grep lies about callers.** `get_pack_detail` reads as called; every
hit is the different, live `get_pack_detail_bundle`. Match on word boundaries
(`\yname\y`) when deciding something is orphaned.
