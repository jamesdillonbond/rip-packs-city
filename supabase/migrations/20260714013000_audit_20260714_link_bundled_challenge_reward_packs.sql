-- Bundled-set challenges were left with reward_pack_dist_id NULL (operator/name-linker couldn't map a
-- single set name to a shared "X & Y" reward pack). Per the blog, bundled sets share one reward pack,
-- so completing either earns it. Link them (ingest preserves reward_pack_dist_id -> durable). Fresh
-- Threads & Season Tip-Off share dist 6224 (market exists -> value ~$132); Origins & Equinox share
-- dist 6412 (no sales/pool yet -> stay null until it trades). NULL-guarded. Revert: set them back NULL.
UPDATE public.challenges SET reward_pack_dist_id = '6224'
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND status = 'active'
  AND reward_pack_dist_id IS NULL AND set_name IN ('Fresh Threads','Season Tip-Off');
UPDATE public.challenges SET reward_pack_dist_id = '6412'
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND status = 'active'
  AND reward_pack_dist_id IS NULL AND set_name IN ('Origins','Equinox');
