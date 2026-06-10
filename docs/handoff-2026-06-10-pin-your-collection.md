# Handoff 2026-06-10 — Pin Your Collection: per-wallet IPFS export (UI half)

## Context

Third piece of the IPFS workstream (after handoff-2026-06-09-ipfs-verified-media.md and handoff-2026-06-10-onchain-cid-resolver.md, both shipped). Community math went viral: the entire Top Shot media corpus is ~784 GB — one hard drive. RPC can do what no one else can: tell each collector exactly which CIDs back THEIR collection and how big the drive needs to be, with a ready-to-run pin script. Pure intelligence-product move; nobody else has the wallet-to-CID join.

Cowork already shipped live:

- Migration audit_20260610_topshot_ipfs_assets_pin_sizes — 7 per-asset pin-size columns (bytes) on topshot_ipfs_assets; full catalog re-loaded with sizes (12,546 rows; total corpus sums to 783.7 GB, independently matching the community's 784 GB figure).
- Migration audit_20260610_get_wallet_ipfs_pin_list — SECDEF RPC get_wallet_ipfs_pin_list(p_wallet text) returning (cid, media_type, pin_size, editions_held, moments_held), one row per distinct CID. service_role + postgres EXECUTE only — call it with supabaseAdmin. It handles both the Base join and the parallel-name join internally (catalog parallels carry the parent set's flow id — do not re-derive this in route code).
- Verified on 0xbd94cade097e50ac: 27,102 distinct CIDs, 342 GB total, 15,681 video CIDs. Query returns in a few seconds — cache accordingly.
- Also shipped this session (operator side, recorded here for the ledger): cron-job.org job 7777382 "RPC TopShot Onchain Art Backfill" -> /api/admin/backfill-topshot-onchain-art, daily 09:49 UTC, cloned auth from the Pinnacle Catalog Backfill entry; live-fired 01:36 UTC: pipeline_runs ok=true, scanned 27, resolver_misses 27 (unpinned WNBA tail — expected), 0 errors. The route is now production-verified end to end.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 — API route: GET /api/pin-list

New file: app/api/pin-list/route.ts (or fold under an existing profile/wallet API namespace if one fits better — your call; verify what exists).

- Auth: session-gated (requireUser pattern) — RPC is auth-walled anyway; v1 is for signed-in collectors. Take ?wallet=0x... and lowercase it; optionally restrict to the user's saved/verified wallets if that check is cheap (saved_wallets), otherwise any wallet is fine — the data is public-chain-derived and non-sensitive.
- Calls supabaseAdmin.rpc('get_wallet_ipfs_pin_list', { p_wallet: wallet }).
- Returns JSON: { wallet, cid_count, total_bytes, by_type: {...}, rows: [...] } plus two format switches:
  - ?format=txt — newline-separated bare CIDs (Content-Disposition attachment, <wallet>-cids.txt)
  - ?format=script — a commented bash script: header with wallet, date, CID count, human total size, then one "ipfs pin add <cid>" per line (attachment, pin-collection-<wallet>.sh). Include a comment line pointing at IPFS Desktop/Kubo install docs.
- Cache: s-maxage=3600 is fine (collection churn is slow and the catalog is daily-fresh).

## Item 2 — Dashboard surface

Where: the dashboard collection view (verify the actual component — dashboard was deliberately decluttered, so keep this SMALL: one card or row, not a hero section).

- Card: "PIN YOUR COLLECTION" (display font) — copy: "Your Top Shot media is X.X GB across N files on IPFS. Host it yourself — no account, no permission." Two buttons: "CID list (.txt)" and "Pin script (.sh)" hitting the route above with the active wallet. A small "what is this?" link to /blog/permanent-moments-ipfs.
- Show a video/artwork split if cheap (by_type comes back from the route).
- Brand tokens only (var(--rpc-red) / var(--font-display) / var(--font-mono)); numbers in mono.
- Optional, good virality: also render the same card on the public /share/[wallet] page footer as a read-only stat ("This collection = X GB on IPFS") WITHOUT download buttons — public pages shouldn't trigger the RPC per anonymous hit; if you do this, precompute/cache aggressively or skip v1.

## Item 3 — Blog post addendum (one paragraph, optional)

app/blog/permanent-moments-ipfs/page.tsx — under the existing "What we did with it" section, add one line announcing the feature: signed-in collectors can now download their collection's CID list + pin script from the dashboard. Keeps the post the canonical narrative of the whole arc.

## Guardrails (repeat every handoff)

- Direct to main. No branches, no PRs.
- Commit via PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration cap 800s. CRLF: full-file writes only.
- The RPC is service_role-only — never call it from a client-side supabase instance; never widen its grants.
- Run smoke after deploy; log this + the two Cowork migrations + cron job 7777382 in docs/overnight/ledger.md.

## Expected end state

Commit on main, deploy READY: signed-in users download their collection's CID list / pin script from the dashboard; blog post mentions it; ledger records the feature plus the pin-size reload, the RPC, and the new cron entry.
