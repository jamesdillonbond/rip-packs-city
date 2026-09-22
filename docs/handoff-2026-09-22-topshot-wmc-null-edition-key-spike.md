# Handoff — Top Shot `wallet_moments_cache` NULL-`edition_key` spike (2026-09-22)

**Source:** weekly data-quality sweep (`docs/overnight/data-quality-sweep-2026-09-22.md`, check 3b).
**Severity:** medium — real integrity defect in the TS wallet-moments drain; small live blast radius; not growing.
**Why handed off:** the fix is in ingest/drain logic, which the read-only sweep is forbidden to touch.

## What was observed (all read-only, project `bxcqstmqfzmuolpuynti`)

- `wallet_moments_cache` (wmc) rows for TopShot (`collection_id = 95f28a17-224a-4025-96ad-adf8a4c63bfd`) with `edition_key IS NULL`: **19,625**, up from **144** at the 09-08 sweep. The contract is `wmc.edition_key = editions.external_id`; NULL breaks it and yields a moment with NULL `player_name`, NULL `fmv_usd` — it renders as an unknown/valueless moment.
- These are **19,624 distinct `moment_id`** across **21 wallets**. Top 3 (all **non-seeded**):
  - `0xa2d42d20ad998e78` — 9,250, written 2026-09-11 05:57 UTC, never re-seen
  - `0xd9db9ac2cfcdeba4` — 5,216, written 2026-09-11 05:48 UTC, never re-seen
  - `0xcb5e15ebe4440e35` — 3,900, written 2026-09-11 05:46 UTC, never re-seen
- **4 of 21 wallets are in `seeded_wallets`** (the user-facing surfaces), carrying only **65** NULL moments: `0xb695650f54eb8b5c` (50), `0xbd94cade097e50ac` (13), `0xa24c5570b7bbb23f` (1), `0x6d1f8c18412c6abc` (1).
- Not runaway: only **13** NULL rows re-seen in 48h, **314** in 7d. `created_at` on the bulk clusters at the 2026-09-11 05:46–05:57 UTC window; a few 50-row batches on 09-13/14/16.
- Overall TS wmc is 1,623,878 rows / 1,138 wallets, so NULL-key is 1.21% — but 100% concentrated in 21 wallets.

Full 21-wallet list: `0x01acbd32f387cc3e, 0x0443bb06b96ba03f, 0x0f2d9ce8346e806b, 0x2cad71c44ba127a7, 0x3a40b295302434a3, 0x3eda8a96c8fe63ef, 0x4845dbd7f5deee61, 0x489710e94122914d, 0x6d1f8c18412c6abc, 0xa24c5570b7bbb23f, 0xa2d42d20ad998e78, 0xb695650f54eb8b5c, 0xba1a13299beb4b19, 0xbb2a9681a21c5089, 0xbd94cade097e50ac, 0xc87eeae8b237a7a0, 0xcb5e15ebe4440e35, 0xd9db9ac2cfcdeba4, 0xddfbe848a81b2236, 0xef9d48c6c83df220, 0xfb0bd110014210b3`

## Hypothesis

The TS wmc drain resolves each held moment to an `edition_key` (`setID:playID[::subID]`). For these moments the resolution returned nothing and the drain **persisted a NULL row rather than resolving-or-skipping** — the classic "write the failure as a fact" shape (CLAUDE.md honesty canon; an `unknown` that is actually KNOWN, #80). The tight 05:46–05:57 window on 2026-09-11 for the three large wallets points to a single drain run over large collector wallets whose moment→edition lookups mostly missed (uncataloged moments, a lookup timeout writing NULL, or a batch cap). The 50-row batches suggest a per-scan page cap of 50 for some wallets.

## What to do

1. **Find the writer.** Grep the wmc drain / wallet-scan path for where `edition_key` is set on insert/upsert. Confirm whether a failed edition lookup writes NULL vs skips the row.
2. **Add a resolve-or-skip guard.** A moment whose edition can't be resolved should not land as a NULL-`edition_key` wmc row that renders as a real (nameless) holding. Either resolve on write, or omit and let the next scan retry — do **not** persist NULL as if it were a fact.
3. **Check the 09-11 run.** Look at what the three large non-seeded wallets were scanned by (on-demand lookup vs batch) around 2026-09-11 05:46–05:57 UTC, and why ~18.4k lookups missed. Rule out a transient edition-catalog outage in that window.
4. **Disposition the 19,625 stale rows.** They haven't been re-seen (13/48h). Decide: force a re-scan of the 21 wallets to re-resolve, or prune the NULL-key rows (they're not surfacing FMV anyway). Prioritize the 4 seeded wallets' 65 moments (user-facing).
5. **Verify:** after the fix + a re-scan, `SELECT count(*) FROM wallet_moments_cache WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND edition_key IS NULL` should trend back toward the ~144 baseline.

## Revert path

No code shipped by the sweep — this is a flag + handoff only. The two docs (`data-quality-sweep-2026-09-22.md`, this file) are additive; revert = delete them. Any fix Claude Code ships gets its own ledger entry + revert path.
