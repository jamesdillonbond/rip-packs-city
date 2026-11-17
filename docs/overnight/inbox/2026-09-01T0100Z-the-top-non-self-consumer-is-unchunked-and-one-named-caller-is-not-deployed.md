> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T0100Z — the top non-self consumer is UNCHUNKED (~4,000+ ids), so it is not the UFC functions — and one of the two named callers is not even deployed

**Pass:** cloud-only, 17:59 PT / 00:59Z, fired by the **superseded** duplicate task `trig_01AZzLzkTPp5xbSjK1EFmeCw`.
**Repo:** `origin/main` **7c63fa3**, fetched 01:09Z (unchanged ~16.5 h).
**Health:** 🟢 GREEN. **Nothing shipped.**

## 1. Deployed source ≠ repo source, and it matters

`get_edge_function` on the live deployments:

- **`scan-ufc-wallet` v39 has NO `fmv_snapshots` read at all.** It does a Flow `getIDs()` and a
  `wallet_moments_cache` upsert, nothing else. The **repo** file
  `supabase/functions/scan-ufc-wallet/index.ts:259-261` **does** carry the D27 shape.
- **`enrich-ufc-wallet` v46 DOES carry it** — the FMV preload, 200-wide slices, no explicit `.limit()`
  (so PostgREST's `db-max-rows` 1000 applies), re-run on **every chunked invocation** of the same wallet.

⚠ So the 00:30Z filing's "two UFC edge functions" is **one**, and there is a **latent regression**:
`supabase functions deploy scan-ufc-wallet` from a clean tree would *introduce* the anti-pattern to prod.

## 2. The payload is ~20× bigger than anyone has assumed

Measured this pass, same session, same state, `queryid 1387451210050502049`:

| array | rows matched | buffers | ms |
|---|---:|---:|---:|
| 200 UFC editions | 1,881 | 2,608 | 384 |
| 19,933 NBA Top Shot editions | 929,531 | 885,637 | 12,184 |
| same, colder re-run | 929,850 | 885,960 | 27,768 |
| **production** (31.4-min diff, 45 calls) | — | **181,793/call** | **2,894/call** |

Buffers ratio and time ratio **independently** put production's array at **~4,100–4,700 ids**.
A 200-id Top Shot slice is ~13 k buffers — the 21:10Z arithmetic was off by ~20×.
👉 **The caller is UNCHUNKED**, which rules out every chunked `.in("edition_id", …)` site in the repo.
No unchunked emitter of that select list exists on `origin/main`.

## 3. The 1,000-row cap IS truncating for this caller

At 200 UFC ids: 881 rows dropped, **0 editions** lost (batched pricing) — the earlier "latent, not live"
verdict is correct *at UFC scale*. At ~4,000 ids: 1,000 of ~190,000 rows. At collection scale: 1,000 of
929,531. **For the real caller most editions come back with no FMV at all.**

## 4. Mechanism, and why there is no index to ship

The planner estimates `edition_id = ANY(<array>)` at **722 rows** vs 929,531 actual (**1,287× under**) and
therefore sorts. The ordered alternative **already exists** (`idx_fmv_snapshots_2026_computed_at_desc`,
98 MB) and **`SET enable_sort = off` did not switch the plan** — it kept the sort under a +1e10 penalty.
⛔ Not a missing index. ⛔ Not a statistics problem either: `fmv_snapshots_2026` (the only real partition,
717 MB) autovacuumed 19:37Z and autoanalyzed 18:09Z today.

## 5. What failed, so the next pass does not repeat it

Two `pg_stat_activity` samplers (22.5 s and 25 s, ~0.25 s cadence) caught **0** executions. Duty cycle is
~7 % and calls arrive in bursts. **Sample 3-4 minutes, or read the Supabase edge-function logs.**
Scratch table `public.audit_20260901_fmvsnap_catch` was created and dropped inside the pass.
