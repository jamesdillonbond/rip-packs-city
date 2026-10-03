# Handoff → Cowork (interactive, Trevor present) · 2026-10-03 · Rigged pre-2023-11 pack opens via Dune

**Why Cowork, and why interactive:** both items need something only an interactive Cowork chat on Trevor's machine has. Item 1 needs Trevor's signed-in dune.com in Chrome. Item 2 is destructive SQL, which the nightly pass may not ship and the MCP will only run after Trevor approves the prompt. The scheduled passes should NOT pick this up.

**Paste into a Cowork chat:**

> Read `docs/handoff-2026-10-03-rigged-dune-query-for-cowork.md` in the rip-packs-city repo and do items 1 and 2. Stop and ask me if dune.com is not signed in.

---

## Context (verified 2026-10-03 9:56 AM PT)

- Rigged = `0xf77bf547fccf6656`. Confirmed opens **21,314** = 14,127 NFT pack opens (`pack_rips`) + 7,187 custodial delivery txs (`chain_arrival_probes`, senders `0xe1f2a091f7bb5245`, `0xb6f2481eba4df97b`, `0xfa57101aa0d55954`). Re-count query: `docs/reference/packs.md`, the "Rigged … pack-open count" bullets.
- RPC can't see two things. (a) Anything before 2023-11-08: the older spork nodes are gone, and 4,727 moments he held at that date have no source. (b) Custodial packs he sold straight back to Dapper whose moments never reached `sales`. On 2026-10-03, 88 such packs were found only because `sales` held one of each pack's three moments.
- Dune `flow.cadence_events` reads the chain back to ~2021 and sees both.

## Item 1: save and run the Dune query (Chrome, dune.com)

1. Open dune.com in Trevor's Chrome (signed in). New query, engine DuneSQL.
2. **STEP 0 first:** run a 1-row probe of one `A.0b2a3299cc857e29.TopShot.Deposit` and one `TopShot.Withdraw` row from `flow.cadence_events` (`LIMIT 1`, recent `block_date`). Read the `data` JSON. If `to` / `from` / `id` are nested (e.g. under an Optional wrapper), fix the `json_extract_scalar` paths in the query. Don't run the full query on unchecked paths.
3. Paste `docs/research/dune-rigged-custodial-opens-2026-09-29.sql`, with fixed paths if needed. Run it. It is aggregated: about 60 rows × 5 columns. The drafted cost note is ~46 credits.
4. Save the query (private is fine) and note its numeric **query id**.
5. Export the result as CSV to `docs/research/dune-rigged-custodial-opens-results-2026-10.csv`.
6. Report in PT, with numbers:
   - **Validation, 2023-11-08 onward:** compare rows with `nft_pack = false` from the Dapper delivery accounts against RPC's 7,187. Expect Dune ≥ RPC. A Dune count BELOW RPC means the query or the JSON paths are wrong: stop and say so, don't publish.
   - **Before 2023-11-08:** custodial txs per month and sender. Name the delivery account(s) of that era (high-volume senders of multi-moment txs). Don't assume `0xe1f2…`: Dapper's delivery account changes over time (packs.md).
   - **Lifetime figure:** 14,127 NFT opens + Dune custodial txs (all eras, Dapper senders only). Packs are counted as distinct txs, the same unit RPC uses. Also check for NFT pack opens before 2023-11 that `pack_rips` lacks (`nft_pack = true` rows).
7. Write the result into `docs/reference/packs.md` (a new dated bullet under the Rigged count bullets) and `docs/sessions/2026-10.md`. Record the query id there too. With it, `workers/dune-proxy` `/execute?query_id=` can re-run the query later without a browser.

## Item 2: drop the scratch table (Supabase MCP; Trevor approves the prompt)

`public.scratch_flip_probe` is a finished 88-row hand control from 2026-10-03. Its comparison is done: the lane's 87 + 1 matched it. RLS is on and anon/authenticated access is revoked, so it is not exposed. It just shouldn't sit in `public`.

1. `SELECT count(*) FROM public.scratch_flip_probe;`: expect 88. If it is not 88, stop: someone else is using it.
2. `DROP TABLE public.scratch_flip_probe;`
3. Verify: `SELECT to_regclass('public.scratch_flip_probe');` returns NULL.
4. Add a ledger line: date · dropped scratch table · revert: none needed (scratch data, reproducible from `chain_arrival_flip_reads`).

## Don't

- Don't run the Dune query unaggregated, which would mean a datapoint blow-up.
- Don't change `apply_chain_arrival_pack_pulls`' allowlist from Dune output alone. A new delivery account is allowlisted on the **tx-signer test** (packs.md: "The test for a delivery source is the tx SIGNER, not the sender's sales count"). File it as a proposal instead.
