# For Cowork: apply the trophy picker "Load more" migration, then ship its code from the parked branch (Claude Code's apply was held twice)

- **Source:** Claude Code cloud session, 2026-11-08 ~7:40–7:58 AM PT. Trevor asked for "Load more" in the trophy picker after a Dame Time challenge entrant could not find Dame's Extra Spice: 3 of the 15 collectors who hold one have more than 96 Damian Lillards, so the Extra Spice sits behind the picker's 96-row cap. Trevor (~7:55 AM PT): "If you can't do it, Supabase doesn't prompt, then hand it to cowork."
- **State: the DB does NOT have it.** `apply_migration` was held for the destructive-statement confirmation (the migration DROPs the old 5-arg signature) and timed out unanswered at ~7:42 and ~7:57 AM PT. Live re-read at ~7:56 AM PT: one function `get_user_top_owned_moments(p_user_id uuid, p_limit integer, p_league text, p_collection_id uuid, p_query text)`, `md5(prosrc)` = `f90d1f03be36ad6307af6af2c43d22b8` (= `20261108153540`, shipped this morning).
- **The code is parked, NOT on `main`:** branch `claude/epic-carson-7x3ok7`, single commit `b08918dfc3d489d82e07aa9c501c91e1d37fd862` on top of `bf8efedc2`. It carries the migration file, the route (`?offset` → `p_offset`, `hasMore`), the picker ("Load 96 more" button), the DB-invariant test copy (§10) and the drift-guard pointer. It is held off `main` on purpose: shipped before the DB, every "Load more" click fails (PGRST202). Page one is unaffected either way (the route sends `p_offset` only for offset > 0).

## Do

1. **Re-read the live function** (MCP `execute_sql` is fine):
   ```sql
   select md5(prosrc), pg_get_function_identity_arguments(oid)
   from pg_proc where proname = 'get_user_top_owned_moments';
   ```
   Expect exactly ONE row, the 5-arg signature above, md5 `f90d1f03be36ad6307af6af2c43d22b8`. **If the md5 differs, STOP** — someone changed the function since; the migration is a full-body write and would revert their change. Note it here and leave it for Claude Code.
2. **Apply the file verbatim in the dashboard SQL editor** (its destructive-operation dialog is the confirmation Claude Code could not answer). Fetch it from
   `https://raw.githubusercontent.com/jamesdillonbond/rip-packs-city/b08918dfc3d489d82e07aa9c501c91e1d37fd862/supabase/migrations/20261108155000_audit_20261108_trophy_picker_load_more_offset.sql`
   and check SHA-256 = `f0f66f9e1f340570a5e9a3dec88e31100d5a59bdb2fe6c2f33ec387be2ac99bc` before running. Append its `schema_migrations` row with the file's own version **20261108155000** and name `audit_20261108_trophy_picker_load_more_offset` (as the 11-08 trophy-cap drain did), so no rename is needed.
3. **Read back:**
   ```sql
   select md5(prosrc), pg_get_function_identity_arguments(oid)
   from pg_proc where proname = 'get_user_top_owned_moments';
   -- expect ONE row: ..., p_query text, p_offset integer  (the 5-arg one is gone)
   select has_function_privilege('anon', 'public.get_user_top_owned_moments(uuid,integer,text,uuid,text,integer)', 'EXECUTE') as anon,
          has_function_privilege('authenticated', 'public.get_user_top_owned_moments(uuid,integer,text,uuid,text,integer)', 'EXECUTE') as authed;
   -- expect false, false
   select count(*) from public.get_user_top_owned_moments(
     (select sw.user_id from wallet_moments_cache w join saved_wallets sw on sw.wallet_addr = w.wallet_address
      where w.player_name = 'Damian Lillard' and w.set_name = 'Extra Spice' and w.fmv_usd > 0
      group by sw.user_id order by count(*) desc limit 1),
     96, null, null, 'Damian Lillard', 96);
   -- expect > 0 for a heavy Dame holder (page 2 exists)
   ```
   `check_public_security_invariants()` should still be `[]`.
4. **Ship the code** (push-capable clone): `git fetch origin main claude/epic-carson-7x3ok7 && git checkout main && git pull --ff-only && git cherry-pick b08918dfc`. Reword the commit to drop the `WIP` prefix and the "NOT for main" line (`git commit --amend`). Run `npm ci` if needed, then `npx vitest run __tests__/api-profile-top-moments.test.ts __tests__/component-TrophyPickerModal.test.tsx __tests__/db-invariants-drift-guard.test.ts`. Ledger entry FIRST (its own commit), code commit as the tip, push to `main`, and confirm the Vercel production deploy for that SHA reaches READY.
5. **After:** a ✅ RESOLVED section here and its marker in INDEX.md (append-only; do not archive). Leave the branch; its remote delete hits the 403 trap (tooling-gotchas.md).

- **Revert (DB):** `DROP FUNCTION public.get_user_top_owned_moments(uuid, integer, text, uuid, text, integer);` then re-apply the 5-arg body from `20261108153540_audit_20261108_trophy_picker_search_matches_every_word_across_fields.sql` with its REVOKE — but revert the route's `p_offset` FIRST, or a later page 404s. Until the code ships, the DB change alone is harmless: every current caller binds to the new signature with `p_offset = 0`.
- **Risk:** LOW. Callers: `/api/profile/top-moments` only (service role; used by the trophy picker, the dashboard's Top Owned grid and the avatar picker). The only output change for page one is the final ORDER BY tiebreak (`collection_id`), which matters only for rows tied on fmv, serial AND moment_id. The DROP+CREATE leaves a ~ms window without the function; a `PGRST002`/`PGRST202` burst of ~10–20 s on the picker is possible (every `apply_migration` does this).
- **Proof already done (Claude Code):** DB invariant `supabase/tests/get_user_top_owned_moments.sql` passes locally on Postgres 16 (§10: pages never overlap, their union is the full list, NULL/negative offset = page one). Route + picker tests pass (33 picker tests; planted defects — dropping dedupe, ignoring the offset — fail 3 of them). `tsc` clean; lint ratchet at baseline −1.
