# Handoff 2026-06-13 — Top Shot marketplace buyer/seller gap (extend buyer-backfill beyond source=onchain)

Plain-text handoff for Claude Code on Trevor's machine. Verified read-only against prod (Supabase bxcqstmqfzmuolpuynti) 2026-06-13 ~04:45Z. No DB migration required — route code only.

## Context (what's live vs what this covers)

Already shipped/live: on-chain TS buyer resolution (b7211fb, 2026-06-09) + the topshot-buyer-backfill route (app/api/admin/backfill-topshot-buyers/route.ts) + its temp cron-job.org entry 7776255. That work is COMPLETE for its scope — every source='onchain' TS sale now has buyer+seller+payer+proposer (70,062 sales since Apr 20, 0 null; last 3 days 5,312, 0 null). The backfill has drained its queue (12+ consecutive wrapped / resolved=0 ticks).

This handoff covers the REMAINDER the backfill never targeted: the Top Shot native-marketplace sales ingested via GQL (/api/ingest), which are buyer- AND seller-blind. Cowork shipped nothing here (route code needs CC).

## The finding (all numbers verified read-only, 2026-06-13)

- 105,331 of 176,826 nba_top_shot 2026 sales have buyer_address IS NULL (seller_address NULL on the same rows).
- 100% are marketplace='topshot', split by source: 'topshot_marketplace' = 34,244 (legacy GQL label, stopped ~2026-05-06); (null) = ~23,414 since Apr 20 and STILL GROWING ~270/day; 'ts_history_backfill_v1' = 294.
- Every buyer-blind row carries a real 64-hex Flow transaction_hash (sampled: hex64=true, len 64).
- They are NOT duplicates of the on-chain sales: for each sample, zero source='onchain' sale exists for the same nft_id within 1h (onchain_same_nft_1h=0). These are the TS-native marketplace population the NFTStorefront on-chain indexer does not capture.
- Root cause #1 (backfill scope): app/api/admin/backfill-topshot-buyers/route.ts candidate query is hard-filtered .eq("source","onchain") (~line 82) — that one line is why it reports drained while 105K remain.
- Root cause #2 (live leak): app/api/ingest/route.ts writes the sale (~lines 367-377) with marketplace:"topshot", transaction_hash: tx.txHash, nft_id: nftId — but NO source and NO buyer_address. The TS GQL feed (searchMarketplaceTransactions) carries only seller, so buyer must be recovered by decoding the tx. Both decoder inputs (transaction_hash + nft_id) are already on the row.
- Decoder already exists and is proven on the sibling on-chain sales: decodeTopShotSaleTx(transaction_hash, nft_id) in lib/chains/flow/dapper-v1-tx-decode.ts (returns buyer/seller/payer/proposer).

## Item 1 (primary) — widen the buyer-backfill beyond source=onchain

File: app/api/admin/backfill-topshot-buyers/route.ts

Change: in the candidate SELECT (the `let q = (supabaseAdmin as any).from("sales")...` block, ~lines 78-87), REMOVE the single line `.eq("source", "onchain")`. Keep everything else unchanged: .eq("collection","nba_top_shot"), .is("buyer_address", null), .not("transaction_hash","is", null), .order("sold_at",{ascending:false}), .limit(BATCH), and the cursor `if (cursorBefore) q = q.lt("sold_at", cursorBefore)`.

Why: dropping that filter lets the existing cron (7776255) process ALL null-buyer nba_top_shot sales with a tx_hash. It is safe — source='onchain' rows are already 100% buyer-resolved, so re-including them is a near-empty idempotent no-op, and every UPDATE is still gated on .is("buyer_address", null). At BATCH=300 every 10 min (~1,800/hr) the ~105K backlog drains in ~2.5 days, and it automatically catches the ~270/day the GQL feed keeps adding — so the gap stops growing with no further change.

Verify the decoder on the marketplace tx shape BEFORE relying on it. Pull 5 samples:
  select transaction_hash, nft_id, sold_at from sales where collection='nba_top_shot' and source is null and buyer_address is null order by sold_at desc limit 5;
Then confirm decodeTopShotSaleTx(transaction_hash, nft_id) returns a buyer for each (quick script or a temporary admin probe). High confidence it works — these are TopShot.Deposit.to sales like the on-chain ones — but if some class doesn't decode, scope the widened query to the sources that do rather than spinning on undecodable rows.

Keep cron 7776255 ENABLED — do NOT disable it; it is now the engine for this drain. (It was going to be retired as "drained"; that retirement is cancelled by this handoff.)

Revert: re-add `.eq("source", "onchain")` to the candidate query.

Expected verification: npx tsc --noEmit clean; Vercel deploy READY; within ~30 min topshot-buyer-backfill pipeline_runs show buyers_resolved > 0 again (not 0/wrapped); null-buyer count falls:
  select count(*) filter (where buyer_address is null) as null_buyer, count(*) as total from sales where collection='nba_top_shot' and sold_at >= '2026-01-01';
Baseline at handoff: 105,331 null of 176,826.

## Item 2 (hygiene / forward-labeling) — stamp a source on GQL-ingested sales

File: app/api/ingest/route.ts

Change: in the sales insert object (~lines 367-377), add a source field alongside marketplace:"topshot". Suggested value: source: "topshot_gql". Leave buyer_address unset here — do NOT add a per-sale Flow REST decode to the hot ingest path; the async backfill (Item 1) owns the decode by design.

Before reusing the legacy literal 'topshot_marketplace' instead: check app/api/topshot-fmv-populate/route.ts, which references that string, so re-applying it to live rows doesn't trigger an unintended interaction. A fresh label ('topshot_gql') avoids that risk.

Why: today these rows have source=null (ambiguous, indistinguishable from any other unlabeled path). Labeling makes the cohort explicit for monitoring. This is OPTIONAL — Item 1 already catches null-source rows via the buyer_address IS NULL predicate. Ship for clarity, or skip for the minimal change.

Revert: remove the source line.

Expected verification: new /api/ingest sales carry the label:
  select source, count(*) from sales where collection='nba_top_shot' and sold_at >= now() - interval '1 hour' group by source;

## Why this matters (1 line)

The 2026-06-09 "100% buyer resolution on every sale" win was the on-chain feed only; this closes the other ~one-third of TS sales (the native-marketplace population) — the buyer signal the on-chain-intelligence / new-venue-detection thesis depends on.

## Guardrails

- Commit directly to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- This touches sale-ingest + buyer-resolution, which the nightly autonomous pass treats as OFF-LIMITS — correct that it's a reviewed CC change, not an autoship. No docs/FREEZE.md needed.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s (this route is at 300 — fine).
- Don't string-replace-patch on Windows (CRLF) — full-file write or findIndex on split lines.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## End state

Two small commits on main, deploy READY. topshot-buyer-backfill resumes resolving (buyers_resolved > 0); nba_top_shot null-buyer falls from 105,331 toward the irreducible undecodable floor over ~2.5 days; new GQL sales are labeled and auto-resolved within ~10 min of ingest. Cron 7776255 stays enabled.
