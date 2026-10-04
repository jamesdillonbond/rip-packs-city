# `/api/ready` has returned 500 for eight days — `anon` lost EXECUTE on `health_check`, and nobody read the instrument

**Filed 2026-08-22 ~17:25 PT (2026-08-23 00:25Z), Claude Code interactive.** Found while trying to settle an
unrelated disagreement about a UI caveat — see the last section, because the measurement **overturned my own
proposed fix**, not the other side's.

## The defect

```
[api/ready] health_check failed: 42501 permission denied for function health_check
count=72   users=9   route=/api/ready
first=2026-08-15T08:28:18Z   last=2026-08-22T23:46:40Z
```

Plus a second, older cluster on the same route: `Vercel Runtime Timeout Error: Task timed out after 10
seconds`, count=13, first 2026-06-16.

**Mechanism, measured not inferred.** `app/api/ready/route.ts` builds its client with
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and calls `supabase.rpc("health_check")`. Live privileges:

| role | EXECUTE on `public.health_check()` |
|---|---|
| `anon` | **false** |
| `authenticated` | **false** |
| `service_role` | true |

`prosecdef = true`. ⚠ **So this is DETERMINISTIC, not a rate.** Every anon call fails; the endpoint has been
returning `{status:"error"}` / 500 to that path continuously since 08-15. The count of 72 is *how often
someone loaded an affected page*, not a failure probability.

## Blast radius — three in-repo consumers

- `app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx` — the **thin-volume caveat**
- `app/(collections)/[collection]/market/MarketClient.tsx`
- `app/api/health/route.ts`

The route's own header calls these "monitoring consumers". ⚠ **A readiness probe that has answered `error`
for eight days without anyone noticing is the documented "permanently-red instrument" class** — it is
indistinguishable from a working one at a glance, and nothing here reads it.

✅ **The route's error branch is itself HONEST and needs no change:** it preserves the `status: "error"`
contract, returns 500, and deliberately withholds the driver text (`/api/ready` is anon-reachable via
`PUBLIC_READ_APIS`, so `error.message` would have put Postgres's own wording in front of anyone who asked).
The defect is the privilege, not the handler.

## What caused it — and what did NOT

⚠ **No migration is responsible in the obvious way.** Every migration whose text mentions `health_check` was
audited: **none** contains a `DROP FUNCTION` or a `REVOKE` for it, and the last `CREATE OR REPLACE` was
**2026-06-07** — and `CREATE OR REPLACE` does not reset an ACL. The three `revoke_anon_exec_*` migrations
around that week name other functions, and the closest one (`20260815222730`) applied at **22:27Z, fourteen
hours AFTER the first error at 08:28Z**. **So do not "fix" this by reverting one of those migrations.**

The residual hypothesis, consistent with CLAUDE.md's own warning that this DB carries **both** a PUBLIC
default **and** `ALTER DEFAULT PRIVILEGES` grants: a blanket revoke took `health_check` as collateral.
**UNVERIFIED — the causing statement has not been identified.**

## ⛔ NOT FIXED HERE, deliberately

The fix is a privilege decision and CLAUDE.md puts auth/lockdown off-limits for autonomous shipping. Two
candidates, and they are not equivalent:

1. **`GRANT EXECUTE ON FUNCTION public.health_check() TO anon`** — restores the endpoint as designed, but
   re-widens the anon-executable **SECURITY DEFINER** surface that the 08-15/08-16 pass was deliberately
   narrowing, and `check_secdef_anon_exec_drift()` polices exactly this. ⚠ Note the function is
   SECDEF and takes no arguments, so it cannot be scoped by input.
2. **Move the route to the service-role client** — keeps anon narrow, but runs a heavy SECDEF health check
   on an unauthenticated public endpoint under service_role, and CLAUDE.md records that **no Postgres
   timeout bounds a `supabaseAdmin` RPC** (worst observed 352 s). The existing 10 s Vercel timeouts on this
   route suggest the check is already slow.

**Operator decision.** Whichever is chosen, re-run `check_secdef_anon_exec_drift()` afterwards.

## ⚠ It overturned MY position, which is why it is filed rather than argued

Earlier tonight I converted this same client's `/api/ready` swallow to a three-state "could not check"
notice, was reverted by a guard that pins it, and recorded the disagreement as **unsettleable without the
failure rate**. The rate turns out to be effectively **100% since 08-15** — which sounds like it vindicates
my change, and does the opposite:

⚠ **A UI state explaining that a check is unavailable would have rendered on every affected page for eight
days, while the actual defect — a one-line privilege regression — stayed invisible.** The honest surface
would have made the outage *look handled*. **Fix the endpoint; do not decorate its failure.** The guard's
instinct to leave the caveat alone was better than mine, for a reason neither of us had stated.

---

## UPDATE ~00:50Z — MEASURED, AND **BOTH** FIXES ABOVE ARE WRONG. Do not ship either.

I proposed two candidates and framed it as an operator choice between them. **Measurement says neither
works**, because the premise both share — that `health_check` is a viable synchronous call — is false.

### `health_check` does not complete in 60 s

Run as `postgres` (which holds EXECUTE), in the **quiet window** at ~00:45Z, it did not return inside the
MCP's 60 s cap. ⚠ Per CLAUDE.md that cap abandons the **result, not the query**, so I did not retry — I
looked it up in `pg_stat_activity` instead: still `active` at **76 s**, `wait_event = DataFileRead`. **I
cancelled it** (`pg_cancel_backend`, confirmed 0 remaining) rather than leave ~80 s of disk-IO burn on the
budget this instance is actually constrained by. **I added that load; recording it rather than omitting it.**

### Why that kills candidate 1 (`GRANT EXECUTE … TO anon`)

`authenticator` carries **`statement_timeout=8s`**, and that is the binding ceiling on the PostgREST path —
`anon`'s declared `3s` never applies, because `rolconfig` is a LOGIN-time setting and PostgREST logs in as
`authenticator` then `SET LOCAL ROLE`s. `health_check` declares only a `search_path` (no timeout, and a
function-level one would be inert regardless).

⚠ **So granting anon EXECUTE would swap a `42501` permission error for an `8 s` statement timeout. The
endpoint still returns 500.** It would look like a fix, ship green, and change nothing a user sees — while
consuming 8 s of the IO budget on every page load that probes it, which is strictly worse than failing fast.

### Why it also kills candidate 2 (service-role client)

No Postgres timeout bounds a `supabaseAdmin` RPC, so the call would run until **Vercel** kills it — which is
exactly the second error cluster already on this route (`Task timed out after 10 seconds`, 13 occurrences
since 06-16). Same 500, more IO burned.

### ✅ Corroboration that this is long-standing, not a fluke

`pg_stat_statements` has **4,777 rows since 2026-08-12** (positive control: the table is populated and the
window spans the outage) and **ZERO for `health_check`**. It has not successfully executed in 11 days —
consistent with the anon path dying at the permission check and nothing else calling it.

### The actual fix has to change the SHAPE, not the privilege

`/api/ready` needs an answer in single-digit seconds on an anon-reachable route. A >60 s aggregate cannot be
served synchronously under any role. Options worth costing (**none measured — do not treat as a
recommendation**): precompute the health snapshot on a schedule and have the route read the row; or split
`health_check` so the probe returns only the cheap legs. ⚠ **Whatever is chosen, re-measure — the 60 s figure
is a floor, not the runtime**, since it was cancelled rather than allowed to finish.

---

## ✅ RESOLVED by deep-audit R44 — verified live 2026-08-26 03:25Z (Claude Code, interactive)

This filing's UPDATE concluded that **both** proposed fixes were wrong and that *"the actual fix has to
change the SHAPE, not the privilege."* **That is what shipped, and it shipped end to end.**

- **The route no longer calls `health_check` at all.** It calls `readiness_collection_stats` —
  measured live: `prosecdef = false`, **anon EXECUTE true**, `search_path=public`. `health_check`
  remains correctly **anon-EXECUTE false**, so the anon leak the 08-15 revoke closed stays closed.
- **The bounded probe the filing asked for exists.** `sales_24h` is exact when ≤ 10 and NULL above;
  `thin_volume` is the answer. The route rejects a non-array payload loudly instead of rendering it as
  an empty market.
- ⭐ **AND THE CONSUMER HALF — the risk this filing flagged — was done too.** *"An unknown count must
  not read as 0 in the clients' `?? 0`."* Both consumers read `thin_volume`, not `sales_24h`, and each
  carries a comment saying exactly why: *"`(sales_24h ?? 0) < 10` would coerce 'busy' to 0."*

**Residual, stated rather than implied as zero:** `/api/ready` still logs **8** 10-second Vercel
timeouts and **1** `57014` in 48 h — against a pre-fix state of *every anon call failing
deterministically since 08-15*. The route is healthy; it is not perfect on a saturated instance.
