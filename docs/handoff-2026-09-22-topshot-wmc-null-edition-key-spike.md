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

---

# VERIFIED ON TREVOR'S BOX — 2026-09-22 (Claude Code)

Re-derived every number above, then traced the writer. **The counts hold; the stated
hypothesis does not.** Nothing shipped for this item — see "Why no fix shipped" below.

## Re-derived (all still true)

19,625 NULL-`edition_key` TS rows / 21 wallets / 19,624 distinct moments; **65 rows across
the same 4 seeded wallets**. Newest `created_at` is **2026-09-17**, and **0 rows were
created in the last 48h** — the population is frozen, not growing.

## ⛔ The stated hypothesis is REFUTED

The doc attributes this to "the TS wmc drain persisting a NULL row rather than
resolve-or-skip". The drain is not the writer:

- `runIdOnlyBackfill` (the `edition_key: null` writer in `wallet-backfill-helpers.ts`) is
  documented in its own header as the runner **for non-Top-Shot collections**. It is not on
  this path.
- The Top Shot drain — `app/api/wallet-backfill/route.ts` — computes
  `const editionKey = setID && playID ? \`${setID}:${playID}\` : ""`, i.e. an **empty
  string** on failure, and `upsert_wmc_batch` writes `edition_key` **as sent** (no
  `''`→NULL coercion; verified against `prosrc`). So that path would leave `''`, not NULL.
- **The discriminator: there are ZERO empty-string rows in TS wmc** (1,492,289 base
  `setID:playID` + 111,964 parallel `base::N` + 19,625 NULL + **0** `''`). The drain did
  not write these.

## ⭐ The actual writer

**`app/api/wallet-search/route.ts`** (~L1064-1084). It deliberately splits its cache write
in two so an unresolved row cannot clobber a previously-cached key:

```ts
const unresolvedRows = rows.filter(r => r.momentId && !r.editionKey).map(r => baseRow(r))
```

`baseRow()` has **no `edition_key` field at all**, so the insert omits the column and it
lands NULL. This fits the observed profile exactly where a drain does not: wallet-search is
the **on-demand, anonymous** paste surface, which is why the three large wallets are
**non-seeded**, were written in one 11-minute window on 09-11, and were **never re-seen**.
Someone pasted three big wallets into search. The scattered 50-row batches are later searches.

## 🚨 The real defect is structural, and it is NOT the writer

`rpc_wmc_selfheal_recent` — the mechanism this codebase relies on to fill metadata left
NULL at write time — is keyed on the very column that is missing:

```sql
FROM public.editions e
WHERE e.external_id = wmc.edition_key
  AND wmc.edition_key IS NOT NULL
```

So it heals `tier` / `player_name` / `set_name` / `mint_count` / `team_name`, but **can
never heal a NULL `edition_key`**. These rows are not "awaiting a retry" — they are
**permanently orphaned by construction**. That is the missing re-check path, and it is the
thing worth fixing.

⛔ **Do NOT implement the doc's step 2 ("resolve-or-skip") as written.** Skipping would
*delete a moment the wallet genuinely holds* from every holdings surface and from
`cached_moment_count` — trading a nameless moment for an undercount, which is the worse
honesty defect. The row should stay; what is missing is a way to name it later.

**The fix that fits: a self-heal keyed on `moment_id`, not on `edition_key`** —
`wallet_moments_cache.moment_id` → `moments.nft_id` → `moments.edition_id` →
`editions.external_id`. That path is not used by any current healer, and **it resolves
4,645 of the 19,625 today (23.7%), including 10 of the 65 seeded rows**. The remaining
14,980 have no `moments` row at all and are genuinely unknown until the catalog covers them.

## ⚠ Why no fix shipped (and what the next session must do FIRST)

The backfill was **not** run, because its control is vacuous. The standard arithmetic
detector for a mis-keyed TS row is `serial_number > circulation_count` — but
**`serial_number` is NULL on all 4,645 candidates**, so the check returns
`impossible=0, consistent=0`: it cannot see the property, and a probe that cannot see the
property is not a measurement. The only other validating source is `moments` itself, which
is the table the fill would be trusting — not an independent control. Given Top Shot has a
**recorded mis-key incident** (a writer mis-keyed mint blocks), writing 4,645 unverifiable
edition keys into a user-facing holdings cache is not a safe autonomous act.

**Before filling: establish an independent control.** Options, cheapest first —
(a) resolve a ~30-row sample's `moment_id` on-chain via the Cadence path the drain uses and
compare to the proposed key; (b) fill only where `topshot_moment_subeditions` independently
corroborates the nft→base key; (c) fill the **10 seeded rows** first (user-facing, small
enough to eyeball on the live surface) and leave the 4,635 non-seeded until (a) passes.

**Revert path for any fill:** capture the affected `wallet_moments_cache.id` list into a
scratch table in the same migration; revert = `UPDATE ... SET edition_key = NULL WHERE id IN (<that list>)`.
Do not rely on re-deriving the set afterwards — the fill destroys the predicate that defines it.
