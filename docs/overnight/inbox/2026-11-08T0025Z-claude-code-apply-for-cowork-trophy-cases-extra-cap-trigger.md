# For Cowork: apply one committed migration — the trophy-case cap trigger (Claude Code's apply was held)

- **Source:** Claude Code cloud session, 2026-11-07 ~4:25 PM PT (handoff 11-07 item 11). The file is committed: `supabase/migrations/20261108002000_audit_20261107_trophy_cases_extra_cap_enforced_in_db.sql`. `apply_migration` was held for a confirmation that never reached Trevor, so **the DB does NOT have it**. The route half (`app/api/profile/trophy-cases/route.ts` maps SQLSTATE 23514 `trophy_case_cap_reached` → 409) is shipped and dormant until the trigger exists.
- **What it does:** a BEFORE INSERT trigger on `trophy_cases` takes a per-user advisory xact lock, counts, and refuses the 11th case (`MAX_EXTRA_CASES = 10`, pinned by `__tests__/trophy-cases-cap-enforced-in-db.test.ts`). It closes the count-then-insert race (a double-click could make an 11th case). It adds a new function plus a trigger; it never rewrites an existing object.
- **Do:**
  1. Re-read the live table first: `select tgname from pg_trigger where tgrelid = 'public.trophy_cases'::regclass and not tgisinternal;` (expect none) and `select max(c) from (select count(*) c from trophy_cases group by user_id) x;` (must be ≤ 10; it was 1).
  2. Apply the file's body verbatim (`apply_migration`, name `audit_20261107_trophy_cases_extra_cap_enforced_in_db`, or the SQL editor).
  3. **Rename the committed file to the version the apply recorded**, if it differs from `20261108002000` (migration-parity matches on the version), and run `npm run preflight`.
  4. Read back: the trigger exists; `has_function_privilege('anon', 'public.trophy_cases_enforce_extra_cap()', 'EXECUTE')` = false.
  5. Add a ledger entry and a ✅ RESOLVED section here, with its marker in INDEX.md (append-only; do not archive).
- **Revert:** `DROP TRIGGER IF EXISTS trophy_cases_extra_cap ON public.trophy_cases; DROP FUNCTION IF EXISTS public.trophy_cases_enforce_extra_cap();`
- **Risk:** LOW — one table with 1 row; the only writer is the route above; a refusal is the same 409 the count gives.
