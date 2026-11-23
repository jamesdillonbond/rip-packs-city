# Claude Code → Cowork: one held DELETE (READY): merge two players split across a Jr./no-Jr. spelling (Candy Luis Robert, Panini Andre Jackson)

**Filed 2026-11-23 ~11:47 AM PT by Claude Code cloud** (Trevor: "Keep working through all you can and try to resolve these still open or partial" → known-issues #258 follow-up). The merge DELETEs the duplicate `players` row, which the Supabase MCP holds for a confirmation that never reaches the owner from a cloud session. Route: the dashboard SQL editor (as R153 `20261115183435` was applied), or `apply_migration` in an attended session.

**SQL (ready, self-checking):** [`docs/proposals/merge-two-split-suffix-players-STAGED.sql`](../../proposals/merge-two-split-suffix-players-STAGED.sql). It mirrors R153's applied body: backups, a guard that RAISEs if a drop row is referenced outside `editions`, re-point, delete, aliases, post-conditions. ⚠ Not parse-checked here (no local scratch Postgres in this sandbox). The SQL editor reports any syntax error without applying anything.

## Why

A sweep of `players` pairs whose accent/case-folded names differ only by a generational suffix (Jr / Sr / II / III / IV) found **14 pairs**:
- **12 genuine.** Father/son or namesakes in different eras or teams: Gary Payton / II (Top Shot + Panini: Legends vs current), Tim Hardaway / Jr. (Top Shot + Panini: USA Basketball vs current), Larry Nance, Marvin Harrison, Antoine Winfield, Asante Samuel, Joey Porter, Ron Harper, Glenn Robinson III, and the two Luis Garcías (#258).
- **Two are ONE person split across two rows**, so each player page shows a fraction of their editions (`get_player_editions` picks one row by slug):
  - **Candy:** "Luis Robert" (19 editions) and "Luis Robert Jr." (2). Both are Chicago White Sox.
  - **Panini:** "Andre Jackson Jr." (13: Prizm base + rookies) and "Andre Jackson" (4: Rated Rookies / Retro 1988, his 2023-24 rookie cards).

Kept rows by edition count (R153 rule). Drop rows were read 11-23 ~11:46 AM PT with 0 refs outside `editions`.

## Steps
1. **Premise (MCP read).** Both drop rows exist: `select id, name, (select count(*) from editions e where e.player_id=p.id) from players p where id in ('d8b2efc5-ae1f-4e7f-94c4-e80cbd3b29b7','d88fc832-413d-45a8-b6e3-1d64bd4c30c4')`. Expect 2 and 4 editions. The script's own guard re-checks references.
2. **Run the staged file**, whole, in the SQL editor. If applied via `apply_migration`, commit it as `supabase/migrations/<recorded version>_audit_20261123_merge_two_split_suffix_players.sql`. Via the SQL editor, commit NO migration file (parity); the ledger is the record.
3. **Verify.**
   - `/candy-mlb/player/luis-robert` lists 21 editions.
   - `/candy-mlb/player/luis-robert-jr-` and `/candy-mlb/player/luis-robert-jr` 308 to it.
   - `/panini-blockchain/player/andre-jackson-jr` lists 17 editions.
   - `/panini-blockchain/player/andre-jackson` 308s to it.
4. **Ledger entry** (what moved; the revert is in the SQL header). Mark this filing ✅.
