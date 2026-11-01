-- audit_20261101_ipfs_thumb_mirror_bucket
--
-- A durable mirror of the RESIZED IPFS art that /api/public/ipfs-thumb/<cid>?w= serves.
--
-- WHY (2026-11-01, found on the owner's own trophy case): UFC Strike is the only collection whose
-- art lives on public IPFS and is NOT pinned on Dapper's gateway (582 CIDs, all on ipfs.io). Every
-- render therefore depended on a public gateway answering inside the proxy's 8 s budget, and on
-- 2026-11-01 none did reliably. Production logs, per CID:
--   ipfs.dapperlabs.com=403 (not pinned)  gateway.pinata.cloud=abort_timeout  ipfs.io=429
-- A pg_net probe of 8 gateways x 3 UFC CIDs from the DB host the same hour: Pinata 2/3, Filebase
-- 1/3, ipfs.io / dweb.link / w3s.link / nftstorage.link 0/3 (all 429), 4everland 0/3 (timeouts).
-- No gateway list fixes that, so the bytes now live with us: objects `<cid>/<width>.webp`.
--
-- Written by: the ipfs-thumb route (write-through on a successful resize) and
-- scripts/ipfs-thumb-mirror.mjs (backfill, .github/workflows/ipfs-thumb-mirror.yml). Both use the
-- service role; there is NO anon/authenticated write policy, and none is needed.
-- Read by: the ipfs-thumb route, through the public object URL. A public bucket serves reads
-- without a storage.objects SELECT policy, so no policy is added.
--
-- The content is public NFT art already served anonymously by every gateway; nothing private.
-- No function, no view.
--
-- Revert: delete from storage.objects where bucket_id = 'ipfs-thumbs';
--         delete from storage.buckets where id = 'ipfs-thumbs';
--         (the route falls back to the gateway path on a mirror miss, so it keeps working.)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ipfs-thumbs', 'ipfs-thumbs', true, 2097152, array['image/webp'])
on conflict (id) do nothing;
