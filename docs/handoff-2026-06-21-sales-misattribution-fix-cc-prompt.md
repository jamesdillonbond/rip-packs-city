# RPC Claude Code — close out the TopShot sales mis-attribution bug (writer fix + drain + fmv-recalc) (2026-06-21)

Read `docs/scoping-2026-06-20-26-edition-misattribution.md` first — the investigation + the already-shipped remediation (9,336 sales + 2,842 moments re-keyed, self-healing `remap_misattributed_topshot_sales()` wired into the guard refresh). Invariant: **`wmc.edition_key` is on-chain truth; `sales.edition_id` was wrong.** This prompt is the 3 remaining follow-ups. It needs PROD (the `topshot-proxy` secret + INGEST token) — run it as a prod CC session, not local/MCP.

Ground rules: direct-to-main, no PRs; PowerShell git, verify `git rev-list --count origin/main..HEAD` = 0; tsc clean. After any DB change: `check_public_security_invariants()` = [], `check_secdef_anon_execute_violations()` = [], trust-health 9/9. All re-keys via reversible per-row audit tables (mirror the `audit_20260621_*` pattern). Cadence/GQL reads via `topshot-proxy` only.

## PHASE 1 — WRITER FIX (priority: this is the still-active vector)
Measured now: **9,218 TS sales on UUID-dupe editions (8,765 nfts / 2,646 editions), 3,374 ingested in the last 7 days (~480/day still accruing).** The self-healer cleans the wmc-resolvable ones after the fact; this stops them at the source.

Bug: `app/api/sales-indexer/route.ts` Step 4d (the GQL fallback, lines ~374–462). The `getMintedMoment` query (line 392) requests only TopShot's GQL UUIDs (`play.id`, `set.id`) + `flowSerialNumber` — not the on-chain integer ids. Then:
- lines 430–438: `.eq("set_id", setId).eq("player_id", playId)` matches those GQL UUIDs against `editions.set_id`/`player_id`, which are RPC's INTERNAL UUIDs (FKs to `sets.id`/`players.id`) — a different UUID space, so it fails;
- line 445: falls back to `extKey = ${setId}:${playId}` (UUID:UUID) → `.eq("external_id", extKey)` → lands the sale on an inert UUID-dupe edition.

Fix:
1. Add the on-chain integer ids to the GQL query (line 392): `play{...on Play{ id flowID }}` and `set{...on Set{ id flowId flowSeriesNumber }}`. CASING (footgun, per CLAUDE.md + the working `app/api/ingest/route.ts` `buildEditionKey`): play uses **`flowID`**, set uses **`flowId`**. Confirm these fields exist on `getMintedMoment`'s Play/Set types with a one-off proxy probe before relying on them; if a field name differs, mirror whatever `buildEditionKey` already uses.
2. After `momentData` (line ~422): `const setFlowId = momentData.set?.flowId; const playFlowId = momentData.play?.flowID;`.
3. Resolve to the CANONICAL int-pair edition: `extKey = ${setFlowId}:${playFlowId}` (integers) → `.eq("external_id", extKey)`. This key can never be a UUID-dupe.
4. REMOVE the `.eq("set_id", setId).eq("player_id", playId)` lookup (lines 430–438) — it's the wrong UUID space and the entry to the dupe path. NEVER fall back to a UUID-pair `external_id`.
5. If the int-pair edition doesn't exist (a genuinely new play), call `ensure_topshot_edition_stub` (the existing UUID→int self-heal) instead of landing on / creating a UUID row.
6. Apply the same change in the moments hydrator (`workers/topshot-moments-hydrator/`) — the `moments` table (~1,200 canonically-wrong rows) is the other feeder the indexer trusts at line 377.
7. Keep the DB self-healer (it covers "re-resolve when a moment later appears in wmc with a different canonical edition"); the writer change is the forward-stop.

Verify: re-run the by-source mis-attribution probe (recently-ingested sales where `wmc.edition_key` <> the sale's edition `external_id`) — `topshot_gql` should fall from ~2.7% toward 0; sales landing on UUID editions (`external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`) in the last 24h should go to ~0.

## PHASE 2 — ON-CHAIN DRAIN (clears the backlog the self-healer structurally can't reach: untracked-wallet moments)
Scope (measured read-only): ~846 colliding nfts on the current 44-edition guard need `getMintedMoment` (not in `wmc`); + 106 ambiguous-reverted; up to ~2,567 all-time across 113 editions; plus the UUID-edition nfts not in wmc (subset of the 8,765). Bounded — a few hundred to ~2.5k proxy calls.

Build it Stage-B style: an admin route that resolves each target nft's true `(setID, playID, serial)` via `getMintedMoment` through `topshot-proxy` (request the integer `flowID`/`flowId` + `flowSerialNumber`, same as Phase 1), writes an authoritative `nft_id → identity` map, then re-keys `sales` + `moments` to the canonical editions via reversible audit tables — resolving the `moments` `UNIQUE(edition_id, serial_number)` conflicts by the authoritative identity (the on-chain owner wins). Drain target input = `{colliding nfts not in wmc} ∪ {the ambiguous-reverted set} ∪ {UUID-edition nfts not in wmc}`.

Verify: `topshot_conflated_editions` → 0 and holds; the all-time dup-serial signature → 0.

## PHASE 3 — FMV-RECALC the corrected editions
The re-key changed sales on **2,393 source + 2,393 target editions; 929 source editions are still stale** (the sweep hasn't reached them). Accelerate via the force-stale cron (or a targeted recalc of those editions) so FMV / deal boards / serial-premiums reflect the corrected sales. CANONICAL `fmv-recalc` only — never a bespoke FMV writer.

Verify: `fmv_sanity_flags` 0; spot-check a corrected SOURCE edition (FMV drops after losing mis-attributed sales) and a TARGET (gains them).

## Close-out
After all three the detector converges to 0, the interim conflation guards (deal board + underpriced suppression + the two premium-board `is_conflated` caveats) + this guard can come down, and the FMV foundation is clean. Update CLAUDE.md + `docs/overnight/ledger.md` with revert paths.
