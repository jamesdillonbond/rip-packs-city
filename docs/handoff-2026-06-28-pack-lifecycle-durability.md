# Handoff — Pack lifecycle: durability fix + verification findings (2026-06-28, Cowork)

Follows `docs/handoff-2026-06-27-pack-lifecycle-attribution.md` and CC's pool-reconstruction + EV-calibration ship (`7c7ce83`, `5ee2574`). This session hardened the supply backfill against a data-loss bug and ran an independent correctness audit. All changes are live DB migrations from Cowork; the items needing repo/route work are called out.

## 1. Supply moved to a DURABLE table (was being wiped every catalog re-seed)

**Bug:** `seed-topshot-pack-distributions` upserts `pack_distributions` with `total_minted: 0` and **replaces** `metadata` (`onConflict: dist_id,collection_id`). So every catalog re-seed reset my backfilled supply — observed live: 1,983 → 474 dists.

**Fix (live):** GQL supply now lives in its own table **`public.topshot_pack_supply`** (`dist_id` PK; `total_minted/total_opened/total_sealed/depletion_pct/for_sale/is_sold_out/...`; RLS on, anon SELECT-only) that the seeder never touches. Migrations: `audit_20260628_topshot_pack_supply_table` (+ salvage of the still-intact rows), `audit_20260628_apply_supply_to_durable_table` (rewrote `apply_topshot_supply` to upsert it + `get_topshot_supply_backfill_targets` to target dists missing from it). The edge fn is unchanged (it calls those RPCs). Cron `rpc-backfill-pack-supply` now refills it durably (temporarily `12,42 * * * *` conc 2 to refill; revert to `7 */3 * * *` once full).

**CC root-fix (recommended, optional now):** make the seeder non-destructive — `ON CONFLICT DO UPDATE` should NOT set `total_minted`, and should **merge** metadata (`metadata = pack_distributions.metadata || EXCLUDED.metadata`) instead of replacing. Then `pack_distributions.total_*` could also be populated for `get_pack_detail`. Until then, `topshot_pack_supply` is the source of truth and the views read it.

**Views** (`audit_20260628_lifecycle_durable_supply_and_live_attrib`, `_global_durable_supply`): `v_topshot_pack_lifecycle` / `_global` now read `topshot_pack_supply` for `minted_true/sealed_best/depletion_best/total_minted_all_time`, and read `pack_rips.dist_id` **directly** (COALESCE with the inferred attribution table) so CC's growing pool-attribution flows in automatically — no re-sync needed.

## 2. SECURITY FIX — `v_topshot_pack_realized_ev` had lost `security_invoker`

CC's `calibrated_ev` `CREATE OR REPLACE VIEW` (5ee2574) reset the view's reloptions, dropping `security_invoker=on` (RLS-bypass / Supabase `security_definer_view` ERROR) and leaving default `authenticated` write grants. Fixed live (`audit_20260628_fix_realized_ev_security_invoker`): `ALTER VIEW ... SET (security_invoker=on)` + revoke writes + SELECT-only. **CC: add `WITH (security_invoker = on)` to the view's source** so it survives the next re-deploy. Same flag re-confirmed on the two lifecycle views.

**Monitoring blind spot (worth fixing):** `check_public_security_invariants()` returned clean and did NOT catch this — it doesn't flag views missing `security_invoker` or with `authenticated` write grants. The nightly monitor would have missed the hole. Consider extending the invariant to scan `pg_class WHERE relkind='v' AND NOT (reloptions ~ 'security_invoker=on')`.

## 3. Verification findings (independent read-only audit) — arithmetic clean, two real caveats

PASS: `topshot_pack_supply` internal consistency (opened=minted−sealed, depletion 0–100, 0 violations); global↔per-dist reconciliation exact; no rip double-counting (`SUM(packs_opened)` == count of TS rips with a dist); `calibrated_ev` always within `[modeled, realized]`.

Caveats to know (not blocking):
- **Basis mismatch for Fast Break / multi-listing dists.** `packs_opened` = in-window indexed rips (~Apr→now); `minted_true/sealed_best/depletion_best` = the dist's single `getPackListing` listing (all-time). For recurring Fast Break dists (e.g. `7800`) many listings map to one `dist_id`, so rip-opens (21,559) can exceed the one listing's minted (~3,194). They are different measures — the dashboard labels opened as in-window. Don't treat `packs_opened` and `minted_true` as the same "opened" for these dists.
- **~330 rips disagree between `pack_rips.dist_id` and the seed-time attribution table** (all `method='rip_dist'`), because CC's `backfill_pack_rip_metadata` re-resolved some rips after my one-time seed. The view prefers the **fresh** `pack_rips.dist_id` (correct), so output is right — but the attribution table's `rip_dist` rows are now **vestigial** (the view reads `pack_rips.dist_id` directly). Optional cleanup: `DELETE FROM topshot_pack_rip_attribution WHERE method='rip_dist'` (the empirical/pool resolvers only ever target NULL-dist rips, so this is safe) — left undone to avoid an unnecessary destructive op.

## 4. New view: per-edition pull provenance (for edition pages)

`v_topshot_edition_pull_provenance` (security_invoker) — per TS edition: `pack_pulls_observed` (copies seen pulled from packs in the event window), `distinct_packs`, `observed_pull_share_pct` vs circulation, first/last pull. Answers "what's been pulled" at the edition grain. Window-bounded (underestimates older editions). Not in the main dashboard payload (it's a 513k-row scan — keep it for edition-page lookups or matview it if a hot path needs it). Revert: `DROP VIEW public.v_topshot_edition_pull_provenance;`

## Revert reference (this session)
```
ALTER VIEW public.v_topshot_pack_realized_ev RESET (security_invoker);  -- (don't — keep the fix)
SELECT cron.unschedule('rpc-backfill-pack-supply');
DROP VIEW public.v_topshot_pack_lifecycle_global; DROP VIEW public.v_topshot_pack_lifecycle;  -- then re-create prior defs
DROP FUNCTION public.apply_topshot_supply(text,boolean,int,int,boolean,boolean,jsonb,jsonb,text);
DROP TABLE public.topshot_pack_supply;
```
Full per-migration record for the session ledger (session-7). Numbers at handoff: durable supply refilling (~874/1,989, climbing, 0 failures), security invariants clean, all three lifecycle views `security_invoker=on` + SELECT-only.
