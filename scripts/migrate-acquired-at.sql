-- Propagate acquired_at from moment_acquisitions to wallet_moments_cache
-- Join: wallet_moments_cache.moment_id = moment_acquisitions.flow_id
-- Only update rows where wallet_moments_cache.acquired_at IS NULL

UPDATE wallet_moments_cache wmc
SET acquired_at = ma.acquired_at
FROM moment_acquisitions ma
WHERE wmc.moment_id = ma.flow_id
  AND wmc.acquired_at IS NULL;
