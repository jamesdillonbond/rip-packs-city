# Handoff 2026-06-10 — BUG: /api/pin-list truncated at 1000 rows; swap to the new single-row export RPC

## Context

Cowork verified the shipped pin-list feature (64bd63e) through a signed-in browser session and the JSON summary is WRONG on large wallets: Trevor's wallet returned cid_count 1000 (exactly), 61.9 GB, artwork count 0 — actual is 27,102 CIDs / 342 GB / 11,421 artwork. Root cause: supabase-js RPC reads are subject to the PostgREST 1000-row cap, and get_wallet_ipfs_pin_list orders pin_size DESC, so the surviving 1000 rows were all videos (hence the empty artwork bucket — the .txt/.sh downloads were equally truncated). This is the documented PostgREST-caps-at-1000 footgun.

Cowork already shipped the fix's DB half live: migration audit_20260610_get_wallet_ipfs_pin_export_single_row — new SECDEF RPC get_wallet_ipfs_pin_export(p_wallet text) RETURNS jsonb, ONE row, so the row cap is structurally irrelevant. Shape: { cid_count, total_bytes, video: {count, bytes}, artwork: {count, bytes}, by_type: {<media_type>: count}, cids_text: "<newline-separated CIDs, pin_size DESC>" }. service_role + postgres EXECUTE only. Verified live on 0xbd94cade097e50ac: 27,102 / 342 GB / video 15,681 / artwork 11,421 / cids_text 1.4 MB.

Claude Code's direct file inspection wins over this doc on any disagreement.

## The one change — app/api/pin-list/route.ts

Replace the get_wallet_ipfs_pin_list call with supabaseAdmin.rpc('get_wallet_ipfs_pin_export', { p_wallet: wallet }) and derive everything from the single jsonb:

- json format: cid_count, total_bytes, total_human, split video/artwork, by_type — all present directly; keep omitting the CID list from json.
- txt format: body is cids_text as-is.
- script format: split cids_text on newline and emit the ipfs pin add lines as before.
- Keep auth/gating/caching unchanged. Do NOT re-add any call path that returns the row-per-CID RPC through PostgREST; get_wallet_ipfs_pin_list remains for SQL-side use.

Verify after deploy (signed-in): /api/pin-list?wallet=0xbd94cade097e50ac returns cid_count 27102 and total_human ~342 GB; the .txt download has 27,102 lines; artwork count nonzero. The dashboard card needs no change if it reads the route's json.

Revert: git revert the commit (the old route worked, just truncated).

Guardrails: direct to main, no branches/PRs; PowerShell git; verify push (rev-list count 0); smoke after deploy; ledger entry referencing migration audit_20260610_get_wallet_ipfs_pin_export_single_row.

## Expected end state

Commit on main, deploy READY, pin-list correct on whale wallets (27k CIDs / 342 GB verified), downloads complete, ledger updated.
