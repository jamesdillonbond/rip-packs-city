# Handoff 2026-06-10 — TopShotIPFSResolver is live on-chain: blog correction + edition-badge upgrade + new-drop art wiring

## Context

Follow-up to docs/handoff-2026-06-09-ipfs-verified-media.md (shipped a553f61). A community thread + Roham pointed at A.0b2a3299cc857e29.TopShotIPFSResolver — Cowork verified 2026-06-10 that it is DEPLOYED AND POPULATED on mainnet. The view function getCIDs(setID: UInt32, playID: UInt32, subeditionID: UInt32): {String: String}? returns a mediaType-to-CID map (keys observed: HERO, VIDEO, VIDEO_TALL, VIDEO_SQUARE, PLAYER, IMAGE_PLAYER). subeditionID 0 = Base parallel. The contract also exposes a public gateway var (currently https://ipfs.dapperlabs.com/ipfs/) and emits CIDSet events on every admin write.

Three facts that change what we shipped yesterday:

1. Our blog post and the announcement both said on-chain CID embedding was "underway" — it is LIVE. Our post is now factually stale on that line.
2. The on-chain resolver is FRESHER than the reference-app JS bundle: NBA Cup plays (set 174) absent from the bundle resolve on-chain.
3. The Cadence no-art gap for new drops is closed: getCIDs gives art at seed time.

Cowork already shipped live today: migration audit_20260610_backfill_editions_media_from_onchain_resolver — read getCIDs via Flow REST scripts for the 52 remaining null-art canonical TS editions; 25 resolved on-chain and were backfilled (null thumbs 52 -> 27; the 27 left are 2026 WNBA plays on neither source yet). Spot-verified 3/3 existing topshot_ipfs_assets rows match chain exactly.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 — Blog post correction (small, do first)

File: app/blog/permanent-moments-ipfs/page.tsx (shipped yesterday in a553f61).

The post says the next step is embedding CIDs into on-chain Edition Metadata, "per Dapper... underway." Replace that framing with an update: it has shipped. Suggested copy, adapt to the post's voice and structure — ideally as a short dated "Update — June 10" block so the post visibly tracks the story:

Update, June 10: it's already on-chain. The TopShotIPFSResolver contract now lives on the Top Shot account (0x0b2a3299cc857e29) with a public getCIDs function — give it a set ID, play ID, and subedition, and the chain itself returns the media fingerprints. No bundle, no intermediary, no Dapper server. We verified our entire indexed catalog against it. The map is no longer just drawn by Dapper; it's checkable by anyone, straight off Flow.

Also update the line "the link between your Moment and its media will be fully independent" from future to present tense where it appears.

Revert: git revert the commit.

## Item 2 — Edition-page badge: add the on-chain line

File: app/(collections)/[collection]/edition/[slug]/page.tsx (the Media Verified on IPFS block from a553f61).

Add one short line under the existing footer link: "CIDs also verifiable on-chain via TopShotIPFSResolver.getCIDs on Flow." Optionally link the contract source viewer (https://f.dnz.dev/0b2a3299cc857e29/contract/TopShotIPFSResolver). Keep it static text — do NOT add a live Cadence read to the page path (egress rules: Flow public endpoints block Vercel; any production read must go through a proxy worker, and the page already has the CIDs from our table).

Revert: git revert the commit.

## Item 3 — New-drop art wiring (the durable fix; medium)

Until now, new TS drops seeded via Cadence got int-pair metadata but NO art (known gap; only topshot-catalog-backfill writes thumbnails, from GQL, later). The resolver closes this.

Where: the route that backfills TS catalog art (grep for the topshot-catalog-backfill route under app/api/ — verify the actual path; do not trust this doc's naming) and/or wherever new canonical int-keyed editions are seeded with NULL thumbnail_url.

What: add an on-chain fallback step — for editions still NULL after the existing GQL pass, execute the Cadence script below THROUGH A PROXY (spork-proxy is historical-only; use the existing topshot-proxy pattern or Flow REST via a worker — verify which proxy fronts rest-mainnet script execution today; if none does, this step needs a tiny addition to an existing worker rather than a direct rest-mainnet.onflow.org call from Vercel, which their WAF may block):

import TopShotIPFSResolver from 0x0b2a3299cc857e29
access(all) fun main(setID: UInt32, playID: UInt32, sub: UInt32): {String: String}? {
  return TopShotIPFSResolver.getCIDs(setID: setID, playID: playID, subeditionID: sub)
}

Map HERO -> thumbnail_url, VIDEO -> video_url, prefix with the gateway. Fill NULLs only. Flow REST script-arg encoding gotchas apply (CLAUDE.md API contracts: btoa each arg as JSON {type:"UInt32", value:"<n>"}, Buffer.from for the script body, decode the base64 response).

Also worth wiring (or queueing): a CIDSet event ingest leg in an existing TS event cursor so the topshot_ipfs_assets table stays fresh from chain instead of bundle re-scrapes. Optional; queue if non-trivial.

Verified counts: 25 of 52 null-art editions resolved on-chain today (the migration above); coverage will grow as Dapper back-pins WNBA.

Revert: git revert the commit.

## Guardrails (repeat every handoff)

- Direct to main. No branches, no PRs.
- Commit via PowerShell git on Windows; re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration cap 800s. CRLF: full-file writes only.
- Production reads of Flow/TS APIs go through the proxy layer — never direct from Vercel.
- Run smoke after deploy; log the ship + the Cowork migration (audit_20260610_backfill_editions_media_from_onchain_resolver) in docs/overnight/ledger.md.

## Expected end state

Blog post carries the June 10 on-chain update; edition badge mentions on-chain verifiability; new TS drops get art from getCIDs without waiting for the GQL catalog; deploy READY; ledger records all of it.
