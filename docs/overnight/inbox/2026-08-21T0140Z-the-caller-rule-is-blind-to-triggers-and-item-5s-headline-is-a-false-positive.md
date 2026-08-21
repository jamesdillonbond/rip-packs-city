# The five-source caller rule is blind to `pg_trigger` — 33 live functions read as dead, and area (5)'s headline item is a false positive

**Filed:** 2026-08-21 ~01:40Z (PT: 2026-08-20 18:40) · **Class:** correction to a filed finding + a gap in a documented rule.
**Status:** the CLAUDE.md rule is FIXED (now six sources). The area-(5) item is RETRACTED. No DB change made.

## What I was acting on

[2026-08-20T2325Z-test-coverage-analysis](2026-08-20T2325Z-test-coverage-analysis.md) area **(5)** names a
"highest-stakes single item":

> ⚠ **Highest-stakes single item: `trim_recent_searches`.** It DELETEs, `anon` **and** `authenticated`
> hold EXECUTE on it, it has **zero in-DB callers**, and `grep -rn trim_recent_searches` across all
> `.ts`/`.tsx`/`.sql` in the repo returns **nothing**. An anon-executable deleter with no caller and no
> pin should be pinned or revoked — decide which, but not neither.

Every one of those facts is TRUE. The conclusion drawn from them is not.

## It is a TRIGGER function

```
CREATE TRIGGER trg_trim_recent_searches
  AFTER INSERT ON public.recent_searches
  FOR EACH ROW EXECUTE FUNCTION trim_recent_searches()
```

`tgenabled = 'O'` (enabled). Its body references **`NEW.owner_key`**, which only binds inside a trigger
invocation — so calling it as an RPC raises `record "new" is not assigned yet` and deletes **nothing**.
It keeps the newest 20 rows per `owner_key`; it is a working retention trigger, not a loose deleter.

It is also **SECURITY INVOKER** (`prosecdef = false`), which the filing did not mention and which matters
independently: an anon caller would be subject to RLS even if the call could reach the DELETE.

⚠ **So "pin or revoke" was a remedy for an object that does not exist as described.** Revoking EXECUTE
from `anon`/`authenticated` would not have broken the trigger (Postgres does not check EXECUTE on the
trigger function at fire time) — it would simply have been a no-op dressed as a security fix, and the
"zero callers" line would have stayed in the register as evidence the function was dead.

## The generalizable defect: the caller rule has no trigger source

CLAUDE.md required **FIVE** sources — `pg_proc.prosrc`, `pg_views.definition`, `cron.job.command`, a
full-repo grep, and the Cowork artifacts' HTML. **A trigger function appears in NONE of them.** Its only
caller is a row in `pg_trigger`, which is not a text corpus anyone greps.

Measured live 2026-08-21:

| | |
|---|--:|
| `public` functions | **657** |
| return `trigger` | **38** |
| of those, actually attached to a live trigger | **38 (all)** |
| trigger functions that DELETE or TRUNCATE | **2** |
| **attached functions reading as ZERO-caller under the five-source rule** | **33** |

**33 live, attached functions would be reported dead by the repo's own documented sweep.** This is the
same failure as the artifact-only views CLAUDE.md already records (a four-source sweep would have broken
3 live boards) — one source further out, and with a worse blast radius: dropping a trigger function does
not merely break a board, it silently stops a table's invariant from being maintained.

## Shipped

**CLAUDE.md now requires SIX sources**, adding `pg_trigger`, with the 33-of-38 measurement inline. Paid
for by displacing the `cron.job.command` name-trap's evidence tail, which already lives **verbatim and
richer** in [trust-board-and-safety.md](../../reference/trust-board-and-safety.md) — the rule itself
stays in CLAUDE.md. File measured at **39,948** chars via Node `.length` (limit 40,000, 52 headroom).

## Still open from area (5), and NOT invalidated by this

The rest of area (5) stands on its own — it is only the headline item that was misread:

- **105 of 169 unscheduled writer functions have no SQL pin; 22 delete or truncate.** ⚠ Re-derive that
  105 with `pg_trigger` excluded before working it, since the same blindness inflates it: any trigger
  function in that set is reached by a trigger, not by nothing.
- The **ten `purge_old_*` retention deleters** reached via `prune_log_tables`, whose only test fixtures
  the RPC and so proves the route calls it, not that the cutoff arithmetic deletes the right rows.
  The `<` vs `<=` boundary is the documented class; `NOW()` is transaction-stable, so a pin can insert a
  row at exactly `now() - interval '<retention>'`.

⚠ **And the meta-lesson, which is the one worth keeping:** the filing's facts were individually correct
and its conclusion was wrong, because the *object class* was never checked. **Before acting on a
"zero-caller" finding, ask what KIND of object it is** — a trigger function, a `SECURITY INVOKER` helper
and a dormant RPC all present identically to a text-corpus sweep and want completely different responses.
