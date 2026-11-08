# For Cowork: two placeholder rows from the wallet-search seed bug — one rename, one delete (Claude Code could not apply them)

- **Source:** Claude Code cloud session, 2026-11-07 ~1:20 PM and 4:00 PM PT. The code fix shipped as `246aab468` ("fix(wallet-search seed): degraded rows seed nothing; unknown tier is NULL, not COMMON"; ledger 11-07). The data cleanup was sent through the Supabase MCP twice, and both times the MCP held it for a confirmation that never reached Trevor. **Assume NOT applied.** Trevor's instruction (4:00 PM PT): hand it to Cowork.
- **What is wrong (read 11-07 ~1:20 PM PT; re-read before acting):**
  - `editions` row `external_id = '85:2918'` (Top Shot `95f28a17-224a-4025-96ad-adf8a4c63bfd`), named **"Unknown (error loading) — Dynamic Duos"** since 2026-05-13 (RARE, series 5, circ 750, `player_id` NULL). Its siblings `85:2898`…`85:2909` are named `<Team> — Dynamic Duos`. The wallet cache labels this edition **Brooklyn Nets** (28 rows; the other 35 say "Team Moment"), and no other `85:*` edition is named Brooklyn.
  - `players` row `id = 49325c43-c6ba-41bc-a22f-a3059d528fb3`, named **"Unknown (error loading)"** (team Brooklyn Nets, `external_id nba_top_shot-unknown-error-loading-`, TIER3, inactive, created 2026-09-25). Nothing references it: 0 editions, 0 `player_name_aliases`, 0 `player_relations` (either side), 0 `player_identities` — those are the only FKs to `players`.
- **Do (SQL editor or `execute_sql`; both statements are guarded, so a re-run or a row already fixed is a no-op):**

```sql
begin;
update editions set name = 'Brooklyn Nets — Dynamic Duos'
 where collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' and external_id = '85:2918'
   and name = 'Unknown (error loading) — Dynamic Duos';
delete from players
 where id = '49325c43-c6ba-41bc-a22f-a3059d528fb3' and name = 'Unknown (error loading)'
   and not exists (select 1 from editions where player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3')
   and not exists (select 1 from player_name_aliases where player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3')
   and not exists (select 1 from player_relations where player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3' or related_player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3')
   and not exists (select 1 from player_identities where player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3');
commit;
-- read back: expect 'Brooklyn Nets — Dynamic Duos' and 0
select (select name from editions where collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' and external_id = '85:2918') ed,
       (select count(*) from players where name ilike 'Unknown (error%') stray;
```

- **Before:** re-check that the FK list for `players` is still the four tables above (`pg_constraint where confrelid = 'public.players'::regclass`). If a new FK exists, add its `not exists` clause.
- **Revert:** `update editions set name = 'Unknown (error loading) — Dynamic Duos' where … external_id = '85:2918'`; re-insert the player (`name 'Unknown (error loading)'`, team 'Brooklyn Nets', collection 'nba_top_shot', collection_id Top Shot, `external_id 'nba_top_shot-unknown-error-loading-'`, `player_tier 'TIER3'`, `is_active false`, the same id). There is no reason to revert either.
- **After:** add a ledger entry (data mutation, 2 rows) and a ✅ RESOLVED section on this filing, plus its marker in INDEX.md. Do NOT archive it (the inbox is append-only).
- **Risk:** LOW — a display name on one edition and an unreferenced row. Not price-moving.
