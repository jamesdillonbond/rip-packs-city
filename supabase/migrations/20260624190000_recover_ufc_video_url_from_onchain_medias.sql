-- Recover UFC Strike video_url (was NULL for all 518 editions). UFC has no DB
-- nft->edition map and no derivable video form: the thumbnail is a single-file
-- IPFS image CID (no sibling video), media.ufcstrike.com is a locked S3 bucket,
-- ufcstrike.com is WAF-gated, and dapper.market does not carry UFC. The ONLY
-- source is on-chain: UFC_NFT (0x329feb3ab062d289) exposes MetadataViews.Medias
-- with a distinct video/mp4 entry per edition (a per-edition IPFS CID, shared
-- across that edition's serials -- verified on two serials of one edition).
--
-- Resolution method (run from a Claude Code session 2026-06-24 via the Cadence
-- MCP, mainnet): for each edition, pick one representative held nft from
-- wallet_moments_cache, borrow it as &{NonFungibleToken.CollectionPublic} +
-- borrowNFT(id) (per the UFC Cadence gotcha -- never cast to UFC_NFT.NFT, and
-- Traits fails), resolveView(MetadataViews.Medias), take the first item whose
-- mediaType starts with "video". 518/518 resolved, 0 failures; URLs are
-- ipfs.io/ipfs/<cid> (plus a handful on media.gigantik.io). All 518 were NULL
-- beforehand, so this is pure recovery (no overwrite).
--
-- The full (edition -> video_url) map is preserved in working/backup table
-- audit_20260624_ufc_video_backfill (rn, edition_id, edition_key, old_video_url,
-- new_video_url, moment_id, wallet_address); old_video_url is NULL for every row.
-- Applied live 2026-06-24 via the service-role execute_sql RPC; this file is the
-- repo-parity copy (it re-applies idempotently from the backup table).
--
-- Revert: UPDATE public.editions SET video_url = NULL
--         WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023';
--         (every UFC video_url was NULL pre-recovery, so a blanket NULL is exact.)
UPDATE public.editions e
SET video_url = b.new_video_url,
    updated_at = now()
FROM public.audit_20260624_ufc_video_backfill b
WHERE e.id = b.edition_id
  AND b.new_video_url ~ '^https?://'
  AND e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
  AND e.video_url IS NULL;
