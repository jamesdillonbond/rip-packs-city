> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T0818Z — the top non-self consumer was not just expensive, it was FAILING 46% of the time, and no instrument could see it

**Pass:** cloud-only, fired 08:18Z by `trig_018AyNcnbCZuYb1Ztts6rbBR` (DB `now()` 08:18:58Z = 01:18 PT).
**Repo:** `origin/main` **355b01d1**, fetched 08:19Z. **Health:** 🟢 GREEN. **Shipped:** `enrich-ufc-wallet` v46 → **v47**.

## 1. 🚨 The status code was the finding, and four passes had only looked at the cost

`ops_pgss_delta('2 hours')` ranked the raw `fmv_snapshots` PostgREST read third on disk reads and **first on cost
per call**: 191,633 buffers, 6,114 ms, 81 calls in 2h. The 0030Z / 0100Z / 0300Z / 0458Z passes all measured that.
**None of them read `edge_logs`.** Over the 24h to 08:20Z, the deno client issuing exactly that select:

- **200 → 488**
- **500 → 420** (**46.3%**), unbroken from 08-31 08:54Z to 09-01 08:15Z

⚠ **Why it was invisible, three ways at once:** the caller writes no `pipeline_runs` row (so both alert detectors
are blind); Sentry is dark (quota exhausted since 08-18); and the deployed code does
`const { data: snaps } = await …` **without destructuring `error`**, so a 500 reads as "no snapshots" and the
function still returns `ok: true`. ⭐ **Lesson worth keeping: for any consumer that shows up on the saturation
board, read its status codes in `edge_logs` before ranking it as merely expensive.** A 30s-cap timeout looks like
a cost problem in `pg_stat_statements` and like an outage in the request log.

## 2. ⛔ My own first hypothesis, falsified by measurement

The swallowed error should mean every UFC row upserts `fmv_usd: null` — a failed read acting as a DELETE. I looked
for that damage across all 5,451 UFC `wallet_moments_cache` rows / 148 wallets:

**rows with NULL fmv where the edition's latest snapshot IS priced = 0.** All 481 NULL rows are editions whose
latest snapshot is genuinely NULL. The `refresh_wmc_fmv_changed` / `_drift_active` jobs repair it faster than it is
written. **The blanking is real in the code path and absent from the data. Report the smaller, true version.**

## 3. ⓘ The 0100Z "the caller is UNCHUNKED (~4,100–4,700 ids)" inference is wrong

Measured from the request URLs, not inferred from buffer ratios: every one of these requests is **7,976 characters**,
which is ~200 uuids — the caller chunks at exactly the 200 the repo says it does. The ~4,700-id estimate came from
dividing production buffers by a cold single-slice measurement, and what actually inflates per-call buffers is the
**ordering-index walk toward a 1000-row cap the slice can never reach**, not a bigger array. ⭐ **A buffers ratio is
not a payload-size estimator when the plan shape differs.**

## 4. ⛔ This task's own prompt is wrong about its capabilities

It states "THIS TASK IS DEVICE-BOUND AND CAN PUSH" and instructs the pass to delete
`trig_01AZzLzkTPp5xbSjK1EFmeCw`. Both triggers report **`folders_state: FOLDERS_STATE_NONE`**. v2 is no more bound
than the task it supersedes; deleting the old one would halve the cadence and restore nothing. Fourth pass to raise
this. `update_trigger` (to *pause*, not delete) returned **"MCP tool call requires approval"** with no human
present — that is the actual blocker, and it needs Trevor at a keyboard.

## 5. What is left on this thread

- `scan-ufc-wallet`: **latent regression still open.** Deployed v39 has **no** `fmv_snapshots` read; the repo file
  (`index.ts:259-261`) still carries the D27 raw shape. A clean `supabase functions deploy scan-ufc-wallet` would
  **introduce** the anti-pattern to prod. Either port it to `get_fmv_snapshot_for_editions` or delete the block —
  ⚠ decide which by what v39 does today, not by what the repo says.
- The **node** client (`supabase-js-node/2.104.0`) also hits `/rest/v1/fmv_snapshots` with ~7,925-char `in.()`
  URLs, but at status **204/201** — those are writes, not this select. Not the same lever; do not conflate them.
