# Handoff — silent error-swallowing in ingest/FMV/cursor write paths (2026-08-07, Claude Code)

Four real defects found by a read-only sweep, all in the **silent-data-loss class** this project treats as high-severity. **Not shipped**, and deliberately so: every one is ingest/FMV/cursor-write logic (CLAUDE.md's off-limits-for-autonomous class), each fix carries a real data-loss risk if wrong, and none can be integration-tested from the cloud sandbox (no Flow/spork/block-range egress; writes go to prod). Each needs an operator who can dry-run against real ranges. Finding #1 was verified byte-for-byte against live code; #2–#4 are cited to file:line for quick confirmation. Ordered by severity.

---

## 1. Sales-history backfill family — non-dup insert error swallowed, then the BACKWARD cursor advances anyway → permanent loss

These 5 cron routes scan block ranges **backward** (`event_cursor.last_processed_block` = lowest block already scanned), insert the sales found, then advance the cursor DOWN to `start`. A non-`23505` insert error is only `console.log`'d — it does not throw, does not set `ok=false`, and does not stop the cursor advancing. Backward walk ⇒ the failed range is **never revisited** ⇒ those sales are lost, and the only trace is a `rows_found > rows_written` gap in `pipeline_runs`.

Verified live in `app/api/cron/allday-sales-history-backfill/route.ts`:
```
879  const { error } = await supabaseAdmin.from("sales").insert(batch)
880  if (!error) { rowsWritten += batch.length }
882  else if (error.code === "23505" || error.message.includes("duplicate")) { /* per-row retry — CORRECT, leave it */ }
887  else { console.log(`... sales insert err: ${error.message}`) }   // ← swallowed
...
908  await supabaseAdmin.from("event_cursor").upsert({ id: CURSOR_ID, last_processed_block: newLow ... })  // ← advances regardless
```
Same shape at: `golazos-sales-history-backfill/route.ts:689-713`, `topshot-flowty-sales-history-backfill/route.ts:578-602`, `ufc-sales-history-backfill/route.ts:~691+`, and — worst — `pinnacle-sales-history-backfill/route.ts:411-437`, where a persistent non-23505 error is counted as `rowsSkipped++` (line ~427), i.e. reclassified as a harmless dedupe skip, erasing even the `found>written` signal.

**Fix (matches the already-shipped forward-indexer hardening + its directory-driven test `__tests__/sales-batch-insert-23505-guard.test.ts`):** on a non-`23505` insert error, do NOT advance the cursor this run — record the error, set `ok=false`, and return so the same range is retried next tick. ⚠ **Leave the `23505` per-row-retry branch exactly as-is** (CLAUDE.md: "don't 'fix' those" — the positive branch IS the retry). The pinnacle route additionally needs the `rowsSkipped++`-on-real-error path separated from the dedupe path.
**Why not shipped:** 5 cursor routes, each slightly different; a mistake in cursor-advance = the exact incident class; untestable against real block ranges here. Worst case of the *fix* is a visible stall (safe); worst case of a *wrong* fix is more silent loss — so it must be dry-run, not blind-shipped.

## 2. `app/api/wallet-cache/route.ts:130-143` — RPC error ignored + catch returns a success shape

`upsert_wmc_batch` RPC error is swallowed in the loop (`:132-133`, `console.warn` only), and the outer catch returns `{ ok: true, written: 0 }` on any throw (`:140-142`) — byte-identical to the legitimate "nothing to write" responses. `wallet_moments_cache` is the `nft_id → edition_key` map the #1 backfills read to resolve sales, so a silent write failure here shows `ok:true` while pushing those moments' future sales into `unmapped_sales`.
**Fix:** check the RPC `error` and propagate (surface a non-2xx / `ok:false` with the count that actually landed); the catch must not return `ok:true` on a real failure.

## 3. `app/api/edition-floor/route.ts` `persistFloorToSnapshot` (185-259) — delete-then-blind-insert, unchecked

Reads prior snapshot with no error check (`:212-216`), DELETEs today's snapshots (`:227-231`), re-inserts with the insert error **completely unchecked** (`:254`), all wrapped in a `console.warn`-only catch (`:257-258`) and called via `.catch(()=>{})` (`:277`). Two hidden failures: (a) if the `existing` read errored to null, `base={}` and reinserted rows are floor-only stubs — today's real FMV fields wiped; (b) if the insert fails after the delete, today's `fmv_snapshots` are gone with nothing replacing them → Market/Sniper read corrupted/absent FMV for the rest of the UTC day.
**Fix:** check the `existing` read error (abort the rewrite on error — never rewrite from an empty base); check the insert error and, ideally, order it so a failed insert cannot leave the delete uncompensated (insert-then-conditional-delete, or a transaction/RPC). This is FMV-write logic — highest caution.

## 4. `lib/pinnacle/flow-events.ts:131-137` — `.single()` where `.maybeSingle()` is meant, error unchecked → cursor jump

```
const { data } = await supabase.from("backfill_state").select("cursor").eq("id", BACKFILL_STATE_ID).single()
fromBlock = data?.cursor ?? undefined
```
`error` is not destructured/checked; `.single()` returns `data=null` on a transient read failure against an existing row ⇒ `fromBlock` stays `undefined` ⇒ `:143-145` resets it to `currentHeight - 250`, silently skipping every block between the true cursor and there — a permanent gap (same class as the 2026-07-25 AllDay 31.4M-block cursor-reset incident). **Confirm this module is live first** (which pinnacle events pipeline calls it) — priority scales with that.
**Fix:** `.maybeSingle()` + explicit error check that ABORTS (holds the cursor) on a read error rather than falling through to the reset. The distinction "row absent (seed)" vs "read failed (hold)" must be explicit, exactly like the getCursor guard in `ingest-topshot-pack-opens-history` (which carries a comment about this exact trap).

---

## Clean (verified, do not re-audit)
Forward sales/listings/offers indexers all check their `.single()` cursor error and `throw` (allday/golazos/topshot listings + offers). `fmv-recalc` fatal handler writes a `pipeline_runs` failure row + returns 500 (already hardened — the original silent-stall incident). Empty `catch {}` in `lib/active-collection.ts`, `lib/owner-key.ts`, `lib/admin-token.ts`, `lib/auth/supabase-client.ts`, support-chat stream close are genuine best-effort.
