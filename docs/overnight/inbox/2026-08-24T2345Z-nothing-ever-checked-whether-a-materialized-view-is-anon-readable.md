# ⭐ SHIPPED — nothing ever checked whether a materialized view is anon-readable, and every new one is born that way

Filed 2026-08-24 16:45 PT / 23:45Z (Claude Code, interactive), while closing out the
`mv_panini_squeeze` verification.

**This is the answer to a question the 08-23 filing left open**: why was the standing security
monitor green while the rebuilt `mv_panini_squeeze` sat there with an `anon` SELECT grant? The leak
was caught **by hand in verification**, and that was recorded as luck. It was not luck — the monitor
was never looking at materialized views at all.

---

## How I got here — a null instrument I nearly published as a clean result

Re-measuring panini's ACL at the 25-hour mark, I asked for the grants the ordinary way:

```sql
select array_agg(grantee||':'||privilege_type)
  from information_schema.role_table_grants where table_name='mv_panini_squeeze'
```

It returned **NULL**. One keystroke from reporting "ACL clean, no anon". It is not clean — it is
**blind**. `information_schema.role_table_grants` **returns zero rows for a materialized view.**

The positive control a null result demands, run immediately:

| measurement | value |
|---|---|
| materialized views in `public` | **34** |
| rows in `information_schema.role_table_grants` for **any** of the 34 | **0** |
| `mv_panini_squeeze` `pg_class.relacl` | `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}` |

The MV **demonstrably holds grants** while information_schema reports none. So the zero is the
instrument's blindness, not an absence of privilege — and **any guard reading MV grants through
information_schema passes vacuously over all 34 objects.**

## ⚠ What I got wrong on the way, because it changes the fix

My first framing was *"the security invariant guard is blind to MVs"* — i.e. an existing check
malfunctioning. **That is wrong, and I only caught it by reading the function body instead of
trusting my own hypothesis.**

`check_public_security_invariants()` had five arms, and every one is scoped **by construction**:

| arm | scope |
|---|---|
| `rls_off_base_table` | `pg_tables` (relkind `r`/`p` only) |
| `anon_write_base_table` | explicit `relkind IN ('r','p')` |
| `view_updatable_anon_write` | `information_schema.views` (relkind `v`) |
| `view_unexpected_definer` | explicit `relkind = 'v'` |
| `secdef_trigger_anon_exec` | `pg_proc` |

**Not one of them ever claimed to cover a materialized view's read exposure.** The arms are honest
about what they measure. This is a **MISSING INVARIANT, not a broken check** — and the distinction
matters, because "fix the blind guard" would have sent me editing arms that are correct.

## ⛔ The mechanism is the DEFAULT, so this recurs silently forever without a guard

`ALTER DEFAULT PRIVILEGES` on this database, for schema `public` (measured 2026-08-24):

| grantor | object type | default grant |
|---|---|---|
| `postgres` | table/view/**MV** | `anon=rxm` · `authenticated=rxtm` |
| `supabase_admin` | table/view/**MV** | `anon=arwdDxtm` (**full write**) |

**`r` is SELECT.** Every materialized view created by `postgres` in `public` is **born
anon-readable**, and PostgREST serves an MV the anon role can SELECT at `/rest/v1/<name>` — the anon
key ships in the browser bundle. `proxy.ts` is irrelevant; route-gating is not data-gating.

So the 08-23 panini leak was **not a fluke, it was the default path**, and the reason the other 34
read clean today is that **someone revoked each one by hand**, with nothing checking that they had.

## Live exposure right now: NONE

| | |
|---|---|
| MVs in `public` | 34 |
| readable by `anon` | **0** |
| readable by `authenticated` | **0** |

This is a **latent** gap, not a live P0. It is filed as SHIPPED because the guard is now in place
before the next `CREATE MATERIALIZED VIEW`, not because anything was leaking.

## The fix — `20260824233704_audit_20260824_security_invariant_mv_anon_readable_arm.sql`

A sixth arm on `check_public_security_invariants()`, reading `has_table_privilege` against
`pg_class` (the only source that can see an MV):

```sql
SELECT 'mv_anon_readable'::text, c.relname::text
FROM pg_class c JOIN pg_namespace n3 ON n3.oid = c.relnamespace
WHERE n3.nspname = 'public' AND c.relkind = 'm'
  AND (has_table_privilege('anon', c.oid, 'SELECT')
       OR has_table_privilege('authenticated', c.oid, 'SELECT'));
```

**Ban at zero, not an allowlist** — this repo's stated preference, and satisfiable at today's
population (0 of 34). If a public MV is ever wanted, make the *suppression* the curated list then;
do not weaken the predicate.

### Callers named before editing, per the six-source rule

`pg_proc` → `analytics_smoke_run`, `rpc_ops_snapshot` · `pg_views` → none · `cron.job` → none ·
`pg_trigger` → none · repo grep → `app/api/cron/data-integrity/route.ts`,
`app/api/smoke-test/route.ts`, and 3 `__tests__` files.
**All of them consume the result BY COUNT (`length === 0`); none switches on the `kind` string**, so
a new arm name cannot break a consumer. That is why this was safe to ship as an additive arm.

### ✅ Proven with a positive control, because a new arm returning 0 rows is indistinguishable from a broken one

Granting `anon` SELECT inside a transaction forced to roll back by a `RAISE EXCEPTION`:

```
POSITIVE CONTROL -> mv_anon_readable rows=1 names=mv_panini_squeeze total_invariant_rows=1
```

The arm **sees** a violation, names the right object, and **propagates to the total the consumers
count** — so the smoke test would genuinely fail and page.

**No-change control**, immediately after: `check_public_security_invariants()` = **0 rows** ·
`has_table_privilege('anon','mv_panini_squeeze','SELECT')` = **false** · anon-readable MVs = **0** ·
function `anon` EXECUTE = **false**, `service_role` = **true**. The rollback left nothing behind.

## Consumer copy corrected too — it named 2 of 6 arms

`data-integrity` reported every violation as `"RLS-off or anon-writable base table(s)"`. With six
arms that string **misattributes a view, a secdef trigger fn or an MV to the wrong cause**. It now
reports the `kind` values that actually fired. The smoke-test pass-string had the same shape
("all public base tables have RLS on…") and now names all six arms.
⚠ This is the *"a doc summary of a guard can omit half its assertions"* failure in its live-copy
form: the string was accurate when written against 2 arms and silently decayed as arms were added.

## ⚠ What this does NOT establish

- **It does not cover MV WRITE grants.** `supabase_admin`'s default is `anon=arwdDxtm`. An MV is not
  directly insertable so the practical risk is low, but the arm tests SELECT only — do not read it
  as "MVs are fully hardened".
- **It does not audit the other schemas.** Scope is `public`, which is what PostgREST exposes.
- **It does not fix the default privilege itself.** Stripping `anon=rxm` from
  `ALTER DEFAULT PRIVILEGES` would be the root fix and would also affect every future TABLE and
  VIEW — much larger blast radius, needs Trevor. **This guard makes the recurrence LOUD, not
  impossible.**

## Open question for the next session

`check_anon_write_surface()` also reads `information_schema.role_table_grants`. Its subject is base
tables, so the MV blindness may be out of scope for it by design — **but that was my wrong
assumption once already today.** Read its body before concluding, exactly as I should have here.
