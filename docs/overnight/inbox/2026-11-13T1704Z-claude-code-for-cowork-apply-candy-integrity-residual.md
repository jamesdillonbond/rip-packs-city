# Claude Code → Cowork: apply the Candy integrity-residual migration in the dashboard SQL editor

**Filed:** 2026-11-13 ~9:05 AM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor). **Severity:** LOW (data hygiene; takes `edition_integrity_flags` 34 → ~8).
**Why Cowork:** Claude Code's `apply_migration` raised Supabase's destructive-statement question twice (~7:35 and ~8:55 AM PT 11-13) and both went unanswered within the tool's 60 s — **nothing was applied** (verified: no `schema_migrations` row, no backup table, view md5 unchanged). Trevor, 11-13: "Hand it to cowork."

**Staged files (in the repo):**
- `docs/proposals/candy-integrity-residual-STAGED.sql` — the whole migration (header explains every step).
- `docs/proposals/candy-integrity-residual-PIN-STAGED.sql.txt` — the updated DB pin (`supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql`), passed on a scratch Postgres; a planted defect (mapped-rarity failsafe removed) reds it.

**What it does** (full reasoning in the SQL header):
1. Clears 11 Candy `rarity_label`s that my 11-12 backfill read from the card's NAME ("2025 MLB Tokyo Series Rainbow", "2021 World Series Gold", "… of Rare") — the edition page's new native-rarity chip would show them wrongly.
2. View: a HYDRATED Candy edition (thumbnail) with tier NULL whose key does not end in a mapped rarity (`-core/-uncommon/-rare/-epic/-titan/-legendary`) is tier absent at source — 6 editions whose length-fitted keys the slug test missed. A mapped-suffix key with a NULL tier stays a defect.
3. Releases 7 unheld label-less editions the `:37` orphan cleanup cannot retire, backing every row up first: deletes 6 stale `candy_edition_market_daily` rows WITH data (snapshots from while listings sat on the fake keys), un-attaches 1 inactive offer on a non-card token (`edition_id` → NULL; the offer row stays), deletes 1 unreferenced name-only edition carrying a tier ("2022 MLB ICON All-Star Series - Blue Edition").

## 1. Pre-check (stop if any value differs)

```sql
SELECT md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) AS view_md5,   -- de740c0f87187154b9404f423f46fe6b
  (SELECT count(*) FROM editions e CROSS JOIN LATERAL (SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(e.name,'')), '\s+','-','g'), '[^a-z0-9:_-]','','g'), '-+','-','g'), '^-+|-+$','','g') slug) s
    WHERE e.collection_id='209ade70-32c5-4470-bc7c-4793d660f713' AND e.rarity_label IS NOT NULL AND s.slug<>'' AND right(e.external_id::text, length(s.slug)+1)=':'||s.slug) AS name_labels,   -- 11
  (SELECT count(*) FROM editions u WHERE u.collection_id='209ade70-32c5-4470-bc7c-4793d660f713' AND u.thumbnail_url IS NULL
    AND NOT EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.collection_id=u.collection_id AND w.edition_key=u.external_id)) AS unheld,   -- 7 (fewer is fine: the :37 cleanup may have taken some)
  to_regclass('public.audit_20261113_candy_integrity_residual_backup') AS backup_table;   -- NULL
```

If `view_md5` differs, another session changed the view: STOP and hand back to Claude Code (the migration's own guard would refuse anyway). If `name_labels` ≠ 11 the migration's assertion refuses; hand back.

## 2. Apply (paste the WHOLE staged file, then the history row, as ONE run; confirm the "destructive operation" dialog)

Paste the full contents of `docs/proposals/candy-integrity-residual-STAGED.sql`, then append:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261113_candy_integrity_residual');
```

The script's DO blocks assert their counts and raise on any surprise (the whole run then rolls back — nothing half-applied).

## 3. Post-check

```sql
SELECT (SELECT (row_to_json(t)->>'value') FROM v_rpc_trust_health t WHERE row_to_json(t)->>'metric'='edition_integrity_flags') AS integrity,  -- ≤ ~26 now; ~8 after the next :37 orphan cleanup
       (SELECT canonical_missing_tier FROM v_edition_integrity_flags WHERE collection='candy_mlb') AS candy_missing_tier,        -- ≤ 6 now, 0 after :37
       (SELECT count(*) FROM audit_20261113_candy_integrity_residual_backup) AS backup_rows,                                    -- 19 (11 labels + 6 market + 1 offer + 1 edition)
       md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) AS new_view_md5,                                       -- record it in the ledger
       (SELECT reloptions::text FROM pg_class WHERE relname='v_edition_integrity_flags') AS opts;                               -- {security_invoker=on}
```

## 4. Repo half (one commit after the ledger entry; run `npm run preflight` — it runs the DB pin)

1. Ledger entry first (date · what · new view md5 · revert: re-run the view from `20261113032243_…sql` and restore rows from `audit_20261113_candy_integrity_residual_backup`).
2. `git mv docs/proposals/candy-integrity-residual-STAGED.sql supabase/migrations/<VERSION>_audit_20261113_candy_integrity_residual.sql`
3. `cp docs/proposals/candy-integrity-residual-PIN-STAGED.sql.txt supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql && git rm docs/proposals/candy-integrity-residual-PIN-STAGED.sql.txt`
4. In `__tests__/edition-integrity-flags-pin-matches-migration.test.ts` (line 27) replace `_audit_20261112_ufc_catchphrase_tier_absent_at_source` with `_audit_20261113_candy_integrity_residual`.
5. Commit "db: Candy integrity residual (name-derived labels, hydrated-untiered absent at source, unheld editions released)", push; mark this filing ✅ in `INDEX.md`.
6. After the next `:37` orphan run, confirm `edition_integrity_flags` ≈ 8 (the Top Shot thumbnails waiting on Dapper art — documented, nothing to do).


## ✅ RESOLVED 2026-11-13 ~11:56 AM PT (Cowork cloud, Trevor: "I approve both")

Pre-check matched (view md5 `de740c0f…`, 11 name labels, 7 unheld, no backup table). Ran the staged file (fetched at `96d8127`, SHA-256 checked) + the history row in the SQL editor; confirmed the destructive-operation dialog. Post-check: `edition_integrity_flags` **26**, Candy `canonical_missing_tier` **6**, backup rows **19**, new view md5 `bc7903c18ba28622de478d43933d6ffa`, `{security_invoker=on}`. Recorded as `20261113200000`; file moved to `supabase/migrations/`, pin installed, pin-matches-migration test repointed. Step 6 (≈ 8 after the next `:37` orphan cleanup) checked in the ledger entry.
