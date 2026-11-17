-- 2026-06-29 — AllDay pack-open ingestion foundation (applied via MCP apply_migration
-- `allday_pack_open_ingestion_schema`; this file is the version-controlled copy).
--
-- pack_rips already carries the open rows (it has UNIQUE indexes on pack_nft_id AND
-- tx_hash, so AllDay opens upsert idempotently and never collide with the integer
-- TS pack ids). This migration adds:
--   (a) allday_pack_pull — durable per-pull moment ids revealed at open, so realized
--       pull-value can be resolved later without re-fetching txs.
--   (b) v_allday_pack_lifecycle — security_invoker per-dist lifecycle view mirroring
--       v_topshot_pack_lifecycle. Per-dist coverage is limited until the
--       PackNFT.Mint -> dist map follow-up (pack_purchases attributes only dist 180);
--       the collection aggregate (sum over rows) is meaningful immediately.
-- Ingestion writer: edge fn `ingest-allday-pack-opens` (Flow REST, modes
-- probe/forward/backfill) + pg_cron jobs rpc-allday-pack-opens-{forward,backfill}.

CREATE TABLE IF NOT EXISTS public.allday_pack_pull (
  pack_nft_id     text        NOT NULL,
  moment_nft_id   text        NOT NULL,
  opener_address  text        NOT NULL,
  tx_hash         text        NOT NULL,
  edition_id      uuid        NULL REFERENCES public.editions(id),
  fmv_usd         numeric     NULL,
  sealed_at       timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_nft_id, moment_nft_id)
);
CREATE INDEX IF NOT EXISTS idx_allday_pack_pull_moment ON public.allday_pack_pull (moment_nft_id);
CREATE INDEX IF NOT EXISTS idx_allday_pack_pull_unresolved ON public.allday_pack_pull (pack_nft_id) WHERE edition_id IS NULL;

ALTER TABLE public.allday_pack_pull ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.allday_pack_pull FROM anon, authenticated;

CREATE OR REPLACE VIEW public.v_allday_pack_lifecycle
WITH (security_invoker = on) AS
WITH opened AS (
  SELECT r.dist_id,
    count(*)                                                       AS packs_opened,
    sum(r.moments_pulled)                                          AS moments_pulled,
    round(sum(r.pull_value_usd), 2)                               AS realized_pull_value_usd,
    round(sum(r.pull_value_usd) / NULLIF(count(*), 0)::numeric, 2) AS avg_realized_value_per_pack,
    count(*) FILTER (WHERE r.sealed_at > now() - interval '7 days')  AS opened_7d,
    count(*) FILTER (WHERE r.sealed_at > now() - interval '30 days') AS opened_30d,
    min(r.sealed_at) AS first_open_at,
    max(r.sealed_at) AS last_open_at
  FROM public.pack_rips r
  WHERE r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND r.dist_id IS NOT NULL
  GROUP BY r.dist_id
)
SELECT
  d.dist_id,
  COALESCE(d.title, d.metadata ->> 'name')                    AS title,
  s.total_minted                                              AS minted,
  s.slots,
  COALESCE(o.packs_opened, 0::bigint)                         AS packs_opened,
  COALESCE(o.moments_pulled, 0::bigint)                       AS moments_pulled,
  o.realized_pull_value_usd,
  o.avg_realized_value_per_pack,
  CASE
    WHEN s.total_minted > 0 AND o.packs_opened IS NOT NULL
      THEN round(100.0 * o.packs_opened::numeric / s.total_minted::numeric, 2)
    ELSE NULL::numeric
  END                                                         AS opened_pct_of_minted,
  COALESCE(o.opened_7d, 0::bigint)                            AS opened_7d,
  COALESCE(o.opened_30d, 0::bigint)                           AS opened_30d,
  o.first_open_at,
  o.last_open_at
FROM public.pack_distributions d
LEFT JOIN public.allday_pack_supply s ON s.dist_id = d.dist_id
LEFT JOIN opened o ON o.dist_id = d.dist_id
WHERE d.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;

GRANT SELECT ON public.v_allday_pack_lifecycle TO anon, authenticated;
COMMENT ON VIEW public.v_allday_pack_lifecycle IS 'AllDay per-dist pack lifecycle (opened/realized from pack_rips). Per-dist coverage limited until PackNFT.Mint->dist map; collection aggregate is sum over rows. Built 2026-06-29.';
