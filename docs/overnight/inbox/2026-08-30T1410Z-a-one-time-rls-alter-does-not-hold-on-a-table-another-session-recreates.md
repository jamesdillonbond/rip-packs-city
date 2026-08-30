# ⛔ A one-time `ENABLE ROW LEVEL SECURITY` does NOT hold on a table another session DROPs and re-CREATEs — proven twice in ten hours

**Filed 2026-08-30 ~07:10 PT (14:10Z) by the Claude Code interactive session. MEASURED, and it is a RECURRENCE of a fix I made this morning.**

---

## What happened, both times

`public.audit_20260830_pgss_snap` is another session's `pg_stat_statements` saturation instrument (desktop-VM handoff, item 3: *"a diff on (userid, dbid, toplevel, queryid)"*).

| time | event |
|---|---|
| ~03:2xZ | table created by that session — **RLS off**, `anon`/`authenticated` hold SELECT |
| 03:57Z | I enabled RLS (`20260830035732`) + added a COMMENT explaining the convention; smoke went green |
| **13:57:06Z** | **table RE-CREATED by that session — RLS off again, COMMENT gone** |
| 13:58Z | `Smoke Tests` HARD FAIL on `f821a17fe`: `rls_off_base_table:audit_20260830_pgss_snap` |
| ~14:0xZ | re-enabled; `check_public_security_invariants()` back to `[]` |

**Evidence it was recreated, not altered:** the table holds exactly **one** snapshot (`distinct at = 1`, newest `13:57:06Z`, 4,798 rows) and my `COMMENT ON TABLE` is **gone**. A `DROP`/`CREATE TABLE AS` resets both.

## The lesson, and it has a documented sibling

⭐ **An `ALTER` is a one-shot repair on an object someone else RECREATES.** CLAUDE.md already records the view form of this — *"`CREATE OR REPLACE VIEW` with no `WITH` clause RESETS reloptions and silently strips `security_invoker=on` (four occurrences)"*. **This is the TABLE analogue: `DROP`/`CREATE` resets RLS.** My 03:57Z migration was correct and is now inert; the migration file remains committed and its effect does not.

⚠ **And a one-time ALTER on a transient object is worse than useless in the repo** — a committed migration whose effect is wiped on the next recreate reads as protection that isn't there. That is why this morning's repair got a migration file and today's repair was done with `execute_sql` as scratch DDL instead: repeating the migration per recreate would file protection that expires.

## Scope of the exposure

While RLS is off, `anon` and `authenticated` hold **SELECT** (`has_table_privilege` = true, re-checked; the GRANT survives the recreate because it is a default privilege, so RLS is the only thing standing between anon and the data). The content is a `pg_stat_statements` snapshot — **internal query TEXT, call counts and IO for ~4,800 statements**. No user PII; it publishes the shape of the whole query surface.

⚠ **There is NO cron job that creates it** — `cron.job` scanned for both `pgss_snap` and `pg_stat_statements`, zero rows. It is **session-driven**, and the new "RPC autonomous pass (every 2h)" task makes recurrence likely on a ~2-hourly cadence, not a one-off.

## Two durable fixes — neither taken unilaterally

1. **The owning session enables RLS at creation.** One line in whatever creates the snapshot. Cheapest and most precise, but it needs that session's code, which this one does not own.
2. **A DDL event trigger** (`ddl_command_end` on `CREATE TABLE` / `CREATE TABLE AS`) that enables RLS on any new `public` base table. ⭐ This would make an ALREADY-ENFORCED invariant self-enforcing rather than detected-after-the-fact — the smoke arm *"public base tables: RLS on + no anon write"* already treats any exception as a HARD FAIL, so this invents no policy. ⛔ **Not installed here on purpose:** a database-wide DDL trigger changes the behaviour of every future migration in every session, and a table that legitimately needs anon read before its policy lands would break. That is Trevor's call, not a code session's.

## Suggested action

1. **No emergency** — smoke catches it within ~one workflow cycle, and the repair is one statement. But it will keep recurring, and each recurrence is a real (if modest) public read window.
2. Prefer **option 1**; it removes the cause rather than healing the symptom.
3. ⛔ **Do NOT "fix" this by adding `audit_20260830_pgss_snap` to a smoke-guard allowlist.** The guard is right; the table is genuinely exposed while RLS is off.
4. ⚠ **Do not file another migration for the ALTER.** It will be wiped by the next recreate, and a committed migration whose effect is gone is worse than none.

**Repaired, not fixed. Nothing shipped in the repo for this filing.**
